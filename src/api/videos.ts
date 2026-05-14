import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { file, S3Client, type BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "node:crypto";
import type { S3File } from "bun";
import { stdout } from "node:process";


export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;
  const { videoId } = req.params as { videoId?: string };

  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID != userID) {
    throw new UserForbiddenError("Unauthorized");
  }

  const formData = await req.formData();
  const file = formData.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video size too large");
  }

  const mediaType = file.type;

  if (mediaType != "video/mp4") {
    throw new BadRequestError("Unsupported video format");
  }

  const extension = mediaType.split("/")[1]


  const fileName = randomBytes(32).toString("hex");
  const key = `${fileName}.${extension}`
  const filePath = `/tmp/${key}`;

  await Bun.write(filePath, file);

  const aspectRatio = await getVideoAspectRatio(filePath);

  const fullKey = `${aspectRatio}/${key}`;

  const s3File = cfg.s3Client.file(fullKey);

  const processedFilePath = await processVideoForFastStart(filePath);

  await s3File.write(Bun.file(processedFilePath), { type: mediaType })

  const videoUrl = `${cfg.s3CfDistribution}/${fullKey}`;

  video.videoURL = videoUrl;

  await updateVideo(cfg.db, video);

  await Bun.file(filePath).delete();
  await Bun.file(processedFilePath).delete();

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn([
    'ffprobe',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutText = await new Response(proc.stdout).text()
  const stderrText = await new Response(proc.stderr).text()

  if (await proc.exited != 0) {
    throw Error(stderrText)
  }

  const parsed = JSON.parse(stdoutText);
  const stream = parsed.streams[0];
  const width = stream.width;
  const height = stream.height;

  const ratio = width / height;

  if (Math.abs(ratio - 1.777) < 0.1) {
    return "landscape";
  }

  if (Math.abs(ratio - 0.5625) < 0.1) {
    return "portrait"
  }

  return "other"
}

export async function processVideoForFastStart(inputFilePath: string): Promise<string> {
	const processedFilePath = inputFilePath + ".processed";

	const proc = Bun.spawn([
		"ffmpeg",
		"-i",
		inputFilePath,
		"-movflags",
		"faststart",
		"-map_metadata",
		"0",
		"-codec",
		"copy",
		"-f",
		"mp4",
		processedFilePath
	], {
		stderr: "pipe",
	})

	const stderrText = await new Response(proc.stderr).text()

	if (await proc.exited != 0) {
		throw Error(stderrText)
	}

	return processedFilePath;
}

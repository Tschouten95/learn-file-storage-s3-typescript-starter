import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };

  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  if (video.userID != userID) {
    throw new UserForbiddenError("Unauthorized");
  }

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const MAX_UPLOAD_SIZE = 10 << 20;

  const formData = await req.formData();
  const file = formData.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail size too large");
  }

  const mediaType = file.type;

  if (mediaType != "image/jpg" && mediaType != "image/png") {
    throw new BadRequestError("Unsupported thumbnail format");
  }

  const extension = mediaType.split("/")[1]

  const fileName = randomBytes(32).toString("base64url");
  const filePath = path.join(cfg.assetsRoot, `${fileName}.${extension}`);

  const data = await file.arrayBuffer();


  await Bun.write(filePath, data);

  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}.${extension}`;

  await updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

/**
 * The picture the offline image provider (`MEDIA_GENERATION_PROVIDER=fake`) returns: an 8x8
 * gradient PNG with correct checksums, so everything that decodes a generated image (the avatar
 * route, an attachment preview) works against it. Upstream's own bytes were a 1x1 PNG whose
 * checksum is wrong, which an image decoder refuses.
 */
export const DOZO_FAKE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAjElEQVR42g3KoQEDMAgEwI7TIRgiGo1hA3RNDBqNiYl+jYlhrKLvPl9u4loM4WuczpHs4N/nq01aSyF6TdM1Uh06YE1WyyB2zdIt0hw2sJt2rQ3Z13b6jtyOPRBNUSsgcWd7RIYjBk7TqXUg59pJP5HHcQbQhFqA4BpycsKBgdf0aj3Iu/bSX+RzvN8fpzJoYQhvvh0AAAAASUVORK5CYII=";

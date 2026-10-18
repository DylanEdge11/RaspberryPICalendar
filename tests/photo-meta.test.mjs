import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { exifTakenAt, normalizeTakenAt } from "../photo-meta.mjs";

async function exifOf(exif) {
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).withExif(exif).jpeg().toBuffer();
  return (await sharp(jpeg).metadata()).exif;
}

test("reads DateTimeOriginal from a camera photo", async () => {
  const exif = await exifOf({ IFD0: { DateTime: "2024:01:01 09:00:00" }, IFD2: { DateTimeOriginal: "2019:10:18 14:03:22" } });
  assert.equal(exifTakenAt(exif), "2019-10-18T14:03:22");
});

test("falls back to the file DateTime when there is no original date", async () => {
  const exif = await exifOf({ IFD0: { DateTime: "2021:06:05 08:30:00" } });
  assert.equal(exifTakenAt(exif), "2021-06-05T08:30:00");
});

test("ignores missing, malformed or zeroed dates", async () => {
  assert.equal(exifTakenAt(undefined), null);
  assert.equal(exifTakenAt(Buffer.from("not exif at all, just bytes")), null);
  assert.equal(exifTakenAt(await exifOf({ IFD2: { DateTimeOriginal: "0000:00:00 00:00:00" } })), null);
});

test("normalizes Immich and Google timestamps to local date-time", () => {
  assert.equal(normalizeTakenAt("2021-10-16T14:03:00.000Z"), "2021-10-16T14:03:00");
  assert.equal(normalizeTakenAt("2020-02-29T23:59:59Z"), "2020-02-29T23:59:59");
  assert.equal(normalizeTakenAt("yesterday"), null);
  assert.equal(normalizeTakenAt(null), null);
});

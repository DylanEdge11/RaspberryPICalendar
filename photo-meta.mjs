// Reads when a photo was taken from its EXIF block (as returned by sharp's
// metadata().exif), so the display can offer "On this day" memories without
// another dependency. Returns a local "YYYY-MM-DDTHH:MM:SS" string or null.
export function exifTakenAt(exif) {
  if (!Buffer.isBuffer(exif) || exif.length < 16) return null;
  const base = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? 6 : 0;
  const order = exif.subarray(base, base + 2).toString("latin1");
  if (order !== "II" && order !== "MM") return null;
  const little = order === "II";
  const u16 = (offset) => (offset + 2 <= exif.length ? (little ? exif.readUInt16LE(offset) : exif.readUInt16BE(offset)) : null);
  const u32 = (offset) => (offset + 4 <= exif.length ? (little ? exif.readUInt32LE(offset) : exif.readUInt32BE(offset)) : null);
  if (u16(base + 2) !== 42) return null;

  function readIfd(offset) {
    const tags = new Map();
    const count = u16(base + offset);
    if (count === null || count > 1000) return tags;
    for (let i = 0; i < count; i += 1) {
      const entry = base + offset + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const length = u32(entry + 4);
      if (tag === null || length === null) break;
      if (type === 4 || type === 13) tags.set(tag, u32(entry + 8));
      else if (type === 2 && length >= 19 && length < 64) {
        const start = base + u32(entry + 8);
        if (start + 19 <= exif.length) tags.set(tag, exif.subarray(start, start + 19).toString("latin1"));
      }
    }
    return tags;
  }

  const ifd0 = readIfd(u32(base + 4) ?? 0);
  const exifIfd = Number.isInteger(ifd0.get(0x8769)) ? readIfd(ifd0.get(0x8769)) : new Map();
  // DateTimeOriginal, then DateTimeDigitized, then the file's DateTime.
  for (const value of [exifIfd.get(0x9003), exifIfd.get(0x9004), ifd0.get(0x0132)]) {
    const match = typeof value === "string" && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!match) continue;
    const [, year, month, day, hour, minute, second] = match;
    if (Number(year) < 1900 || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) continue;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }
  return null;
}

// Normalizes a date from Immich or Google ("2021-10-16T14:03:00.000Z") to the same local form.
export function normalizeTakenAt(value) {
  const match = typeof value === "string" && /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]}T${match[2]}` : null;
}

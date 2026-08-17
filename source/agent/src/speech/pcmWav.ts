const VALID_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000]);
const BITS_PER_SAMPLE = 16;
const WAV_HEADER_SIZE = 44;

export function wrapPcmS16LeAsWav(
  pcm: Buffer,
  sampleRate: number,
  channels = 1,
): Buffer {
  if (!VALID_SAMPLE_RATES.has(sampleRate)) {
    throw new RangeError(
      `sampleRate must be one of ${[...VALID_SAMPLE_RATES].join(", ")}`,
    );
  }
  if (channels !== 1) {
    throw new RangeError("channels must be 1");
  }

  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const fileSize = WAV_HEADER_SIZE - 8 + dataSize;

  const header = Buffer.alloc(WAV_HEADER_SIZE);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

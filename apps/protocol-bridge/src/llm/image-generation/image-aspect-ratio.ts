// Gemini GenerateContent ImageConfig.aspectRatio:
// https://ai.google.dev/api/generate-content#ImageConfig
const IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "1:4",
  "4:1",
  "1:8",
  "8:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
])

export function normalizeImageAspectRatio(value?: string): string | undefined {
  const ratio = value?.trim()
  if (!ratio) return undefined
  if (!IMAGE_ASPECT_RATIOS.has(ratio)) {
    throw new Error(`Unsupported image aspect ratio: ${ratio}`)
  }
  return ratio
}

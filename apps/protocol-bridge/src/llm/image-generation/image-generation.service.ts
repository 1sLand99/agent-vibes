import { Injectable, Logger } from "@nestjs/common"
import * as fs from "fs/promises"
import * as path from "path"
import { GoogleService } from "../google/google.service"
import { CodexService } from "../openai/codex.service"
import { normalizeImageAspectRatio } from "./image-aspect-ratio"

export type ImageGenerationProvider = "codex" | "gemini"

export interface ImageGenerationReference {
  path: string
  mimeType: string
  data: string
}

export interface ImageGenerationInput {
  prompt: string
  model?: string
  conversationId?: string
  outputFormat?: string
  aspectRatio?: string
  referenceImagePaths?: string[]
  referenceImages?: ImageGenerationReference[]
}

export interface ImageGenerationResult {
  imageData: string
  revisedPrompt?: string
  status?: string
  provider: ImageGenerationProvider
  mimeType?: string
}

@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name)

  constructor(
    private readonly codexService: CodexService,
    private readonly googleService: GoogleService
  ) {}

  async generateImage(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const prompt = input.prompt.trim()
    if (!prompt) {
      throw new Error("Image generation prompt is required")
    }
    const request = {
      ...input,
      prompt,
      aspectRatio: normalizeImageAspectRatio(input.aspectRatio),
    }

    const errors: string[] = []
    for (const provider of this.resolveProviderOrder(request)) {
      try {
        return provider === "gemini"
          ? await this.generateWithGemini(request)
          : await this.generateWithCodex(request)
      } catch (error) {
        const normalized = this.toError(error)
        errors.push(`${provider}: ${normalized.message}`)
        this.logger.warn(
          `${provider} image generation failed${
            provider === "codex" ? "; trying next provider" : ""
          }: ${normalized.message}`
        )
      }
    }

    throw new Error(`Image generation failed: ${errors.join("; ")}`)
  }

  private resolveProviderOrder(
    input: ImageGenerationInput
  ): ImageGenerationProvider[] {
    const hasReferenceImages =
      (input.referenceImages?.length || 0) > 0 ||
      (input.referenceImagePaths?.length || 0) > 0
    // Do not silently drop an exact aspect ratio during provider fallback.
    if (hasReferenceImages || input.aspectRatio) {
      return ["gemini"]
    }

    const normalized = input.model?.trim().toLowerCase() || ""
    if (normalized.includes("gemini")) {
      return ["gemini", "codex"]
    }
    return ["codex", "gemini"]
  }

  private async generateWithCodex(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const result = await this.codexService.generateImage({
      prompt: input.prompt,
      model: input.model,
      conversationId: input.conversationId,
      outputFormat: input.outputFormat,
    })
    return {
      ...result,
      provider: "codex",
      mimeType: this.inferOutputMimeType(input.outputFormat),
    }
  }

  private async generateWithGemini(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const pathReferences = await this.loadReferenceImages(
      input.referenceImagePaths || []
    )
    const references = [
      ...(input.referenceImages || []),
      ...pathReferences,
    ].slice(0, 3)
    const result = await this.googleService.generateImage({
      prompt: input.prompt,
      model: input.model,
      conversationId: input.conversationId,
      outputFormat: input.outputFormat,
      referenceImages: references,
      aspectRatio: input.aspectRatio,
    })
    return {
      ...result,
      provider: "gemini",
    }
  }

  private async loadReferenceImages(
    referenceImagePaths: string[]
  ): Promise<ImageGenerationReference[]> {
    const normalized = referenceImagePaths
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 3)

    const references: ImageGenerationReference[] = []
    for (const referencePath of normalized) {
      if (!path.isAbsolute(referencePath)) {
        throw new Error(
          "Image reference paths must be admitted absolute filesystem paths"
        )
      }
      const absolutePath = path.resolve(referencePath)
      const data = await fs.readFile(absolutePath)
      references.push({
        path: absolutePath,
        mimeType: this.inferMimeType(absolutePath),
        data: data.toString("base64"),
      })
    }
    return references
  }

  private inferMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg"
      case ".webp":
        return "image/webp"
      case ".gif":
        return "image/gif"
      case ".png":
      default:
        return "image/png"
    }
  }

  private inferOutputMimeType(outputFormat?: string): string {
    const format = outputFormat?.trim().toLowerCase()
    if (format === "jpg" || format === "jpeg") return "image/jpeg"
    if (format === "webp") return "image/webp"
    return "image/png"
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}

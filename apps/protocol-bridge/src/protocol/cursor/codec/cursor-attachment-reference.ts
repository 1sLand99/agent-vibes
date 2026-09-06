import type { UserMessage } from "../../../gen/agent/v1_pb"

/** PromptUploadRef belongs to the official cloud multipart-upload service. */
export class CursorCloudAttachmentError extends Error {
  constructor() {
    super("当前会话未加载此云端附件。请重新附加图片或文件后发送。")
    this.name = "CursorCloudAttachmentError"
  }
}

/** Never interpret an upload id as a blob id, path, or downloadable URL. */
export function assertLocalCursorAttachments(message?: UserMessage): void {
  const context = message?.selectedContext
  const attachments = [
    ...(context?.selectedImages || []),
    ...(context?.selectedDocuments || []),
  ]
  if (
    attachments.some(
      (attachment) => attachment.dataOrBlobId.case === "promptUploadRef"
    )
  ) {
    throw new CursorCloudAttachmentError()
  }
}

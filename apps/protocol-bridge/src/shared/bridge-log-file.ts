import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/** Open the real log before publishing its latest-file alias. */
export function createBridgeLogStream(
  directory: string,
  onError: (error: unknown) => void
): fs.WriteStream {
  fs.mkdirSync(directory, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `protocol-bridge-${timestamp}-${randomUUID()}.log`
  const filePath = path.join(directory, fileName)
  const latestPath = path.join(directory, "protocol-bridge.log")
  const temporaryPath = `${latestPath}.${randomUUID()}.tmp`
  const stream = fs.createWriteStream(filePath, {
    fd: fs.openSync(filePath, "a"),
    autoClose: true,
  })
  stream.on("error", onError)

  try {
    try {
      fs.symlinkSync(fileName, temporaryPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(code ?? ""))
        throw error
      // Windows may require privileges for symlinks. A hard link stays live,
      // unlike a one-time copy made before the first log write.
      fs.linkSync(filePath, temporaryPath)
    }
    // Rename replaces even a dangling symlink, without following its target
    // or exposing an unlink/create race between concurrent bridge processes.
    fs.renameSync(temporaryPath, latestPath)
  } catch (error) {
    // The timestamped log remains usable if only the convenience alias fails.
    onError(error)
  } finally {
    try {
      fs.unlinkSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error)
    }
  }
  return stream
}

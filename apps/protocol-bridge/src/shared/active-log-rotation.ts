import { copyFileSync, existsSync, statSync, truncateSync } from "fs"

export function rotateActiveLogFileIfNeeded(args: {
  activePath: string
  previousPath: string
  maxBytes: number
}): boolean {
  if (!existsSync(args.activePath)) return false
  if (statSync(args.activePath).size <= args.maxBytes) return false

  copyFileSync(args.activePath, args.previousPath)
  truncateSync(args.activePath, 0)
  return true
}

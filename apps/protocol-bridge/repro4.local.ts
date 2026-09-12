import * as fs from "node:fs"
import { ChatGptWebTurnSession } from "./src/llm/openai/chatgpt-web-turn-session"

const LOG = process.argv[2]!
const started = Date.now()
const say = (line: string) =>
  fs.appendFileSync(
    LOG,
    `${((Date.now() - started) / 1000).toFixed(1)}s ${line}\n`
  )

/** A source that mimics the browser: a few SSE chunks, then it ends. */
async function* fakeSource(): AsyncGenerator<string> {
  const frame = (text: string) =>
    `data: {"p":"","o":"add","c":0,"v":{"message":{"author":{"role":"assistant"},` +
    `"metadata":{"recipient":"all"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]}}}}\n`
  await new Promise((r) => setTimeout(r, 200))
  yield frame("hello")
  await new Promise((r) => setTimeout(r, 200))
  yield 'data: {"p":"/message/content/parts/0","o":"append","c":0,"v":" world"}\n'
  await new Promise((r) => setTimeout(r, 200))
  yield "data: [DONE]\n"
  say("source ended")
}

async function main() {
  const session = new ChatGptWebTurnSession({ source: fakeSource() })
  const iterator = session.segment()[Symbol.asyncIterator]()
  const peek = setInterval(() => {
    const s = session as unknown as {
      queue: unknown[]
      sourceDone: boolean
      ended: boolean
    }
    say(
      `state queue=${s.queue.length} sourceDone=${s.sourceDone} ended=${s.ended}`
    )
  }, 2000)
  for (let i = 0; i < 20; i++) {
    say(`next() #${i} calling`)
    const result = await iterator.next()
    if (result.done) {
      say(`next() #${i} DONE`)
      break
    }
    say(`next() #${i} -> ${/^event: (\S+)/.exec(result.value)?.[1]}`)
  }
  clearInterval(peek)
  say("finished=" + String(session.finished))
  process.exit(0)
}
main().catch((e) => {
  say("ERROR " + String(e))
  process.exit(1)
})

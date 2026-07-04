#!/usr/bin/env node
/**
 * Cursor Protobuf Schema 完整提取器
 *
 * 从 Cursor IDE 的 minified JavaScript bundle 中完整提取 protobuf schema 定义：
 * - Messages（含嵌套 map/oneof/repeated 等字段）
 * - Enums（含所有枚举值）
 * - Services + RPC Methods（含请求/响应类型映射）
 *
 * 修复旧分析器的核心缺陷：
 * 1. [^}]* 被 ES2022 static{} 截断 → 使用 [\s\S]{0,500}? 跨边界
 * 2. [^\]]+ 不支持嵌套 → bracket-depth counting
 * 3. 未提取 enum → setEnumType 模式匹配
 * 4. 未提取 service → method 位置聚类 + I/O 解引用
 * 5. 仅扫描 workbench → 多 bundle 扫描 + 去重合并
 *
 * 用法:
 *   node cursor_proto_extractor.js [options]
 *
 * 选项:
 *   --output-json     输出结构化 JSON
 *   --verbose         输出详细日志
 *   --filter <pkg>    仅输出指定包（如 agent.v1, aiserver.v1）
 *   --stats           仅输出统计信息
 *
 * 输出文件（保存到系统临时目录下的 cursor_proto_extract/）：
 *   cursor.proto          完整 .proto 定义文件
 *   cursor_schema.json    结构化 JSON schema
 *   extraction_report.txt 提取报告
 *
 * 作者: Claude Awesome Team
 */

const fs = require("fs")
const path = require("path")
const {
  resolveCursorAppRoot,
  resolveCursorProtoExtractDir,
} = require("./paths")

// ============================================================
// 配置
// ============================================================

const CURSOR_APP_ROOT = resolveCursorAppRoot()
if (!CURSOR_APP_ROOT || !fs.existsSync(CURSOR_APP_ROOT)) {
  console.error("Error: Cursor app root not found.")
  console.error(
    "Set CURSOR_APP_ROOT or CURSOR_WORKBENCH_PATH if Cursor is installed in a non-standard location."
  )
  process.exit(1)
}

// 动态构建 bundle 路径列表
function discoverBundlePaths() {
  const paths = [
    // 主 workbench bundle（最大，~42MB，包含大部分定义）
    path.join(CURSOR_APP_ROOT, "out/vs/workbench/workbench.desktop.main.js"),
    // 其他核心文件
    path.join(CURSOR_APP_ROOT, "out/main.js"),
    path.join(
      CURSOR_APP_ROOT,
      "out/vs/workbench/api/node/extensionHostProcess.js"
    ),
  ]

  // 动态扫描 extensions/cursor-* 目录
  const extDir = path.join(CURSOR_APP_ROOT, "extensions")
  if (fs.existsSync(extDir)) {
    for (const entry of fs.readdirSync(extDir).sort()) {
      if (!entry.startsWith("cursor-")) continue
      const distMain = path.join(extDir, entry, "dist/main.js")
      const distExt = path.join(extDir, entry, "dist/extension.js")
      if (fs.existsSync(distMain)) paths.push(distMain)
      else if (fs.existsSync(distExt)) paths.push(distExt)
    }
  }

  return paths
}

const BUNDLE_PATHS = discoverBundlePaths()

const OUTPUT_DIR = resolveCursorProtoExtractDir()

// Protobuf scalar type 编号映射
const SCALAR_TYPES = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  10: "group",
  11: "message",
  12: "bytes",
  13: "uint32",
  14: "enum",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
}

// MethodKind 映射
const METHOD_KINDS = {
  0: "unary",
  1: "server_streaming",
  2: "client_streaming",
  3: "bidi_streaming",
}

// CLI 参数
const args = process.argv.slice(2)
const OUTPUT_JSON = args.includes("--output-json")
const VERBOSE = args.includes("--verbose")
const STATS_ONLY = args.includes("--stats")
const filterIdx = args.indexOf("--filter")
const FILTER_PKG = filterIdx !== -1 ? args[filterIdx + 1] : null

// ============================================================
// 数据存储
// ============================================================

const schema = {
  metadata: {
    timestamp: new Date().toISOString(),
    cursorAppRoot: CURSOR_APP_ROOT,
    bundlesScanned: [],
  },
  // varName -> fullTypeName 映射
  varToType: {},
  // bundle basename -> varName -> fullTypeName 映射
  // Minified identifiers are not globally unique across Cursor bundles.
  varToTypeByBundle: {},
  // fullTypeName -> varName 映射
  typeToVar: {},
  // fullTypeName -> { fields: [...], sourceBundle }
  messages: {},
  // fullTypeName -> { values: [...], varName, sourceBundle }
  enums: {},
  // serviceName -> { methods: [...], sourceBundle }
  services: {},
  // 统计信息
  stats: {},
}

function getBundleMap(bundleKey) {
  if (!schema.varToTypeByBundle[bundleKey]) {
    schema.varToTypeByBundle[bundleKey] = {}
  }
  return schema.varToTypeByBundle[bundleKey]
}

function recordVarType(
  varToBundle,
  bundleKey,
  bundleId,
  varName,
  fullName,
  options = {}
) {
  if (!varName || !fullName) return
  const bundleMap = getBundleMap(bundleKey)
  if (options.force || !bundleMap[varName]) {
    bundleMap[varName] = fullName
  }

  if (
    options.forceGlobal ||
    !schema.varToType[varName] ||
    varToBundle[varName] === bundleId
  ) {
    schema.varToType[varName] = fullName
    schema.typeToVar[fullName] = varName
    varToBundle[varName] = bundleId
  } else if (!schema.typeToVar[fullName]) {
    schema.typeToVar[fullName] = varName
  }
}

function resolveVarInBundle(bundleKey, varName) {
  const bundleMap = schema.varToTypeByBundle[bundleKey]
  return (bundleMap && bundleMap[varName]) || schema.varToType[varName]
}

function applyAliasMappings(content, bundleKey, bundleId, varToBundle) {
  const aliasPairs = []
  const aliasRx =
    /(?:^|[;,])\s*(?:(?:let|var|const)\s+)?([\w$]+)\s*=\s*([\w$]+)(?=[,;}])/g
  let m
  while ((m = aliasRx.exec(content)) !== null) {
    if (m[1] === m[2]) continue
    aliasPairs.push([m[1], m[2]])
  }

  let changed = true
  let passes = 0
  while (changed && passes < 20) {
    changed = false
    passes++
    const bundleMap = getBundleMap(bundleKey)
    for (const [alias, target] of aliasPairs) {
      const targetType = bundleMap[target]
      if (!targetType || bundleMap[alias] === targetType) continue
      if (bundleMap[alias] && bundleMap[alias] !== targetType) continue
      recordVarType(varToBundle, bundleKey, bundleId, alias, targetType)
      changed = true
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function findLocalTypeInModule(moduleBody, localVar) {
  const name = escapeRegExp(localVar)
  const patterns = [
    new RegExp(
      `class\\s+${name}\\s+extends\\s+[\\w$.]+[\\s\\S]{0,2500}?typeName\\s*=\\s*"([^"]+)"`
    ),
    new RegExp(
      `${name}\\s*=\\s*class(?:\\s+[\\w$]+)?\\s+extends\\s+[\\w$.]+[\\s\\S]{0,2500}?typeName\\s*=\\s*"([^"]+)"`
    ),
  ]
  for (const pattern of patterns) {
    const match = moduleBody.match(pattern)
    if (match) return match[1]
  }
  return null
}

function applyModuleMemberMappings(content, bundleKey, bundleId, varToBundle) {
  const moduleExports = new Map()
  const moduleRx = /(\d+):\([^)]*\)=>\{([\s\S]*?)(?=,\d+:\([^)]*\)=>|\}\)\(\{)/g
  let moduleMatch
  while ((moduleMatch = moduleRx.exec(content)) !== null) {
    const moduleId = moduleMatch[1]
    const moduleBody = moduleMatch[2]
    const exportMatch = moduleBody.match(/[\w$]+\.d\([\w$]+,\{([^}]+)\}\)/)
    if (!exportMatch) continue

    const exportsForModule = {}
    const exportRx = /([\w$]+):\s*\(\)\s*=>\s*([\w$]+)/g
    let exportEntry
    while ((exportEntry = exportRx.exec(exportMatch[1])) !== null) {
      const exportName = exportEntry[1]
      const localVar = exportEntry[2]
      const typeName = findLocalTypeInModule(moduleBody, localVar)
      if (typeName) exportsForModule[exportName] = typeName
    }
    if (Object.keys(exportsForModule).length > 0) {
      moduleExports.set(moduleId, exportsForModule)
    }
  }

  const importRx =
    /(?:^|[;,])\s*(?:(?:let|var|const)\s+)?([\w$]+)\s*=\s*[\w$]+\((\d+)\)/g
  let importMatch
  while ((importMatch = importRx.exec(content)) !== null) {
    const alias = importMatch[1]
    const moduleId = importMatch[2]
    const exportsForModule = moduleExports.get(moduleId)
    if (!exportsForModule) continue

    for (const [exportName, typeName] of Object.entries(exportsForModule)) {
      const memberRef = `${alias}.${exportName}`
      if (resolveVarInBundle(bundleKey, memberRef)) continue
      recordVarType(varToBundle, bundleKey, bundleId, memberRef, typeName)
    }
  }
}

// ============================================================
// Phase 1: Bundle 加载
// ============================================================

function loadBundles() {
  const loaded = []
  for (const bundlePath of BUNDLE_PATHS) {
    if (!fs.existsSync(bundlePath)) {
      if (VERBOSE) console.log(`[SKIP] 未找到: ${bundlePath}`)
      continue
    }
    const content = fs.readFileSync(bundlePath, "utf-8")
    const basename = path.relative(CURSOR_APP_ROOT, bundlePath)
    const sizeMB = (content.length / 1024 / 1024).toFixed(2)
    loaded.push({ path: bundlePath, basename, content, sizeMB })
    schema.metadata.bundlesScanned.push({ path: basename, sizeMB })
    if (VERBOSE) console.log(`[LOAD] ${basename}: ${sizeMB} MB`)
  }
  return loaded
}

// ============================================================
// Phase 2: VarName ↔ TypeName 映射
// ============================================================

function buildVarTypeMapping(bundles) {
  // 跟踪每个变量名映射来自哪个 bundle，用于防止跨 bundle 误覆盖
  const varToBundle = {}

  for (const bundle of bundles) {
    const content = bundle.content
    const bundleId = bundle.path || bundle.name || "unknown"
    const bundleKey = bundle.basename || bundleId
    let m

    // 策略 1: fromBinary 模式（最可靠）
    // typeName="xxx" ... fromBinary(e,t){return new VarName().fromBinary(e,t)}
    const rx =
      /typeName="([^"]+)"[\s\S]{0,600}?fromBinary\(e,t\)\{return new (\w+)\(\)/g
    while ((m = rx.exec(content)) !== null) {
      const fullName = m[1]
      const varName = m[2]
      if (!schema.varToType[varName]) {
        recordVarType(varToBundle, bundleKey, bundleId, varName, fullName)
      }
    }

    // 策略 2: fromJsonString 模式（补充 fromBinary 遗漏）
    // typeName="xxx" ... fromJsonString(e,t){return new VarName().fromJsonString(e,t)}
    const rx2 =
      /typeName="([^"]+)"[\s\S]{0,800}?fromJsonString\(e,t\)\{return new (\w+)\(\)/g
    while ((m = rx2.exec(content)) !== null) {
      if (!schema.varToType[m[2]]) {
        recordVarType(varToBundle, bundleKey, bundleId, m[2], m[1])
      }
    }

    // 策略 3: setEnumType 模式（enum 变量映射）
    // setEnumType(VarName, "pkg.EnumName", [...])
    const enumVarRx =
      /(?:[\w$]+(?:\.[\w$]+)*\.)?setEnumType\(([\w$]+)\s*,\s*"([^"]+)"/g
    while ((m = enumVarRx.exec(content)) !== null) {
      if (!schema.varToType[m[1]]) {
        recordVarType(varToBundle, bundleKey, bundleId, m[1], m[2])
      }
    }

    // 策略 4: getEnumType 引用解引用
    // 在 field 定义中，enum 的 T 值是 b.getEnumType(VarName) 的返回值
    // 但 minified 后，T 直接引用的是 getEnumType 的参数表达式
    // 实际上 T:b.getEnumType(VarName) 被 minified 为一个赋值表达式
    // 这里我们提取所有 getEnumType(VarName) 引用并建立映射
    const getEnumRx = /getEnumType\(([\w$]+)\)/g
    while ((m = getEnumRx.exec(content)) !== null) {
      // m[1] 是 enum 的变量名，已在策略 3 中映射
      // 这里主要用于确保没有遗漏
      if (!schema.varToType[m[1]]) {
        // 在 setEnumType 中也搜索一下这个变量
        const enumDefRx = new RegExp(
          "(?:[\\w$]+(?:\\.[\\w$]+)*\\.)?setEnumType\\(" +
            m[1] +
            '\\s*,\\s*"([^"]+)"'
        )
        const enumMatch = content.match(enumDefRx)
        if (enumMatch) {
          recordVarType(varToBundle, bundleKey, bundleId, m[1], enumMatch[1])
        }
      }
    }

    // 策略 5: equals 静态方法模式（proto-es 常见）
    // static equals(a,b){return b.util.equals(VarName,a,b)}
    // 其中 VarName 在 typeName 定义附近
    const equalsRx =
      /typeName="([^"]+)"[\s\S]{0,800}?equals\(\w+,\w+\)\{return \w+\.util\.equals\((\w+)/g
    while ((m = equalsRx.exec(content)) !== null) {
      if (!schema.varToType[m[2]]) {
        recordVarType(varToBundle, bundleKey, bundleId, m[2], m[1])
      }
    }

    // 策略 6: typeName 回溯法（最全面）
    // 在 proto-es minified 代码中，class 定义有多种格式：
    //   模式 C: },VarName=class InternalName extends Base{...typeName="xxx"...}  (最常见！)
    //     注意: VarName 是赋值变量名（T 字段引用的），InternalName 是 class 内部名
    //     fromBinary 等策略错误地把 InternalName 映射了，模式 C 必须修正
    //   模式 A: class VarName extends Base{...} (VarName 同时也是 class 名)
    //   模式 B: let/var/const VarName = class extends Base{...}
    const typeNameRx = /typeName="([^"]+)"/g
    while ((m = typeNameRx.exec(content)) !== null) {
      const fullName = m[1]
      if (fullName.includes("-")) continue

      const lookback = 3000
      const start = Math.max(0, m.index - lookback)
      const before = content.substring(start, m.index)

      // 模式 C: VarName=class InternalName extends Base{... (最常见！)
      // 覆盖同一 bundle 内策略 1/2 创建的 InternalName 映射
      // 因为 fromBinary 把 InternalName 映射了，但 T: 引用的是 VarName
      // 注意: 不覆盖来自其他 bundle 的映射（跨 bundle 的 minified 变量名不唯一）
      const assignClassMatches = [
        ...before.matchAll(
          /([\w$]+)\s*=\s*class\s+[\w$]+\s+extends\s+[\w$]+\s*\{/g
        ),
      ]
      if (assignClassMatches.length > 0) {
        const lastMatch = assignClassMatches[assignClassMatches.length - 1]
        const varName = lastMatch[1]
        // 仅在以下情况写入：
        // 1. varName 尚无映射
        // 2. varName 已有映射但来自同一 bundle（修正 InternalName → VarName）
        if (!schema.varToType[varName] || varToBundle[varName] === bundleId) {
          recordVarType(varToBundle, bundleKey, bundleId, varName, fullName, {
            force: true,
          })
        }
        continue
      }

      // 已有映射 则模式 A/B 不再处理
      if (schema.typeToVar[fullName]) continue

      // 模式 A: class VarName extends Base{...
      const classMatches = [
        ...before.matchAll(/class\s+([\w$]+)\s+extends\s+\w+\s*\{/g),
      ]
      if (classMatches.length > 0) {
        const lastMatch = classMatches[classMatches.length - 1]
        const varName = lastMatch[1]
        if (!schema.varToType[varName]) {
          recordVarType(varToBundle, bundleKey, bundleId, varName, fullName)
        }
        continue
      }

      // 模式 B: let/var/const VarName = class extends Base{...
      const letAssignMatches = [
        ...before.matchAll(
          /(?:let|var|const)\s+([\w$]+)\s*=\s*class\s+extends/g
        ),
      ]
      if (letAssignMatches.length > 0) {
        const lastMatch = letAssignMatches[letAssignMatches.length - 1]
        const varName = lastMatch[1]
        if (!schema.varToType[varName]) {
          recordVarType(varToBundle, bundleKey, bundleId, varName, fullName)
        }
      }
    }

    applyAliasMappings(content, bundleKey, bundleId, varToBundle)
    applyModuleMemberMappings(content, bundleKey, bundleId, varToBundle)
  }

  if (VERBOSE)
    console.log(
      `[MAP] VarName -> TypeName 映射: ${Object.keys(schema.varToType).length}`
    )
}

// ============================================================
// Phase 3: Message 提取
// ============================================================

/**
 * 使用 bracket-depth counting 提取 field list 内容
 * 解决嵌套 map 类型 V:{kind:"scalar",T:9} 导致 [^\]]+ 失败的问题
 */
function extractBracketContent(source, startIdx) {
  let depth = 0
  let i = startIdx
  // 找到第一个 [
  while (i < source.length && source[i] !== "[") i++
  if (i >= source.length) return null

  const contentStart = i + 1
  depth = 1
  i++

  while (i < source.length && depth > 0) {
    if (source[i] === "[") depth++
    else if (source[i] === "]") depth--
    i++
  }

  if (depth !== 0) return null
  return source.substring(contentStart, i - 1)
}

/**
 * 解析单个字段对象 {no:1,name:"xxx",kind:"scalar",T:9,...}
 * 支持所有 key: no, name, kind, T, opt, oneof, repeated, default, packed, req, K, V
 */
function parseFieldObject(fieldStr) {
  const field = {}

  // no
  const noMatch = fieldStr.match(/\bno:\s*(\d+)/)
  if (!noMatch) return null
  field.fieldNumber = parseInt(noMatch[1])

  // name
  const nameMatch = fieldStr.match(/\bname:\s*"([^"]+)"/)
  if (!nameMatch) return null
  field.name = nameMatch[1]

  // kind
  const kindMatch = fieldStr.match(/\bkind:\s*"(\w+)"/)
  if (!kindMatch) return null
  field.kind = kindMatch[1]

  // T (类型引用 - 多种格式)
  // 格式 1: T:VarName 或 T:$VarName (直接引用)
  // 格式 2: T:b.getEnumType(VarName) (enum 引用)
  // 格式 3: T:()=>VarName (延迟加载引用)
  // 格式 4: T:9 (scalar 编号)
  // 注意: minified 变量名可以包含 $ 字符（如 $Z, $xe, e$u）
  const enumTMatch = fieldStr.match(
    /\bT:\s*[\w$]+(?:\.[\w$]+)*\.getEnumType\(([\w$]+)\)/
  )
  const lazyTMatch = fieldStr.match(/\bT:\s*\(\)\s*=>\s*([\w$]+)/)
  const directTMatch = fieldStr.match(/\bT:\s*([\w$]+(?:\.[\w$]+)*)/)
  if (enumTMatch) {
    field.T = enumTMatch[1]
    // 将 kind 校正为 enum（有时原始 kind 可能不是 enum）
    if (field.kind !== "enum") field.kind = "enum"
  } else if (lazyTMatch) {
    field.T = lazyTMatch[1]
  } else if (directTMatch) {
    field.T = directTMatch[1]
  }

  // opt (optional)
  const optMatch = fieldStr.match(/\bopt:\s*(!0|!1|true|false)/)
  field.optional = optMatch
    ? optMatch[1] === "!0" || optMatch[1] === "true"
    : false

  // oneof
  const oneofMatch = fieldStr.match(/\boneof:\s*"(\w+)"/)
  field.oneof = oneofMatch ? oneofMatch[1] : null

  // repeated
  const repeatedMatch = fieldStr.match(/\brepeated:\s*(!0|!1|true|false)/)
  field.repeated = repeatedMatch
    ? repeatedMatch[1] === "!0" || repeatedMatch[1] === "true"
    : false

  // packed
  const packedMatch = fieldStr.match(/\bpacked:\s*(!0|!1|true|false)/)
  field.packed = packedMatch
    ? packedMatch[1] === "!0" || packedMatch[1] === "true"
    : false

  // req (required - proto2)
  const reqMatch = fieldStr.match(/\breq:\s*(!0|!1|true|false)/)
  field.required = reqMatch
    ? reqMatch[1] === "!0" || reqMatch[1] === "true"
    : false

  // default
  const defaultMatch = fieldStr.match(/\bdefault:\s*([^,}]+)/)
  if (defaultMatch) field.defaultValue = defaultMatch[1].trim()

  // K (map key type)
  const kMatch = fieldStr.match(/\bK:\s*(\d+)/)
  if (kMatch) field.mapKeyType = parseInt(kMatch[1])

  // V (map value type - 可能是嵌套对象)
  const vMatch = fieldStr.match(/\bV:\s*\{([^}]+)\}/)
  if (vMatch) {
    const vObj = {}
    const vKindMatch = vMatch[1].match(/kind:\s*"(\w+)"/)
    if (vKindMatch) vObj.kind = vKindMatch[1]
    const vTMatch = vMatch[1].match(/\bT:\s*([\w$]+)/)
    if (vTMatch) vObj.T = vTMatch[1]
    field.mapValueType = vObj
  }

  return field
}

/**
 * 从字段列表字符串中解析所有字段
 */
function parseFieldList(fieldsStr) {
  const fields = []

  // 策略：使用 bracket-depth counting 分割顶层 {} 对象
  let depth = 0
  let objectStart = -1

  for (let i = 0; i < fieldsStr.length; i++) {
    const ch = fieldsStr[i]
    if (ch === "{") {
      if (depth === 0) objectStart = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && objectStart !== -1) {
        const fieldStr = fieldsStr.substring(objectStart + 1, i)
        const field = parseFieldObject(fieldStr)
        if (field) fields.push(field)
        objectStart = -1
      }
    }
  }

  return fields.sort((a, b) => a.fieldNumber - b.fieldNumber)
}

function extractMessages(bundles) {
  for (const bundle of bundles) {
    const content = bundle.content

    // 步骤 1: 找到所有 typeName 位置
    const typeNameRx = /typeName="([^"]+)"/g
    let m

    while ((m = typeNameRx.exec(content)) !== null) {
      const fullName = m[1]

      // 跳过非法的 typeName（HTML doctype 错误消息等）
      if (
        fullName.includes("-") ||
        fullName.startsWith("missing-") ||
        fullName.startsWith("invalid-")
      ) {
        continue
      }

      // 如果已经从更早的 bundle 提取了，跳过
      if (schema.messages[fullName]) continue

      // 步骤 2: 在 typeName 之后 500 字符内寻找 newFieldList
      const searchStart = m.index + m[0].length
      const searchEnd = Math.min(content.length, searchStart + 500)
      const searchArea = content.substring(searchStart, searchEnd)

      const nflIdx = searchArea.indexOf("newFieldList")
      if (nflIdx === -1) continue

      // 步骤 3: 使用 bracket-depth counting 提取 field list
      const nflAbsIdx = searchStart + nflIdx
      const fieldsStr = extractBracketContent(content, nflAbsIdx)
      if (fieldsStr === null) continue

      // 步骤 4: 解析字段
      const fields = parseFieldList(fieldsStr)

      schema.messages[fullName] = {
        fields,
        sourceBundle: bundle.basename,
        isEmpty: fields.length === 0,
      }
    }
  }

  if (VERBOSE) {
    const total = Object.keys(schema.messages).length
    const withFields = Object.values(schema.messages).filter(
      (m) => !m.isEmpty
    ).length
    console.log(
      `[MSG] Messages: ${total} total, ${withFields} 有字段, ${total - withFields} 空`
    )
  }
}

// ============================================================
// Phase 4: Enum 提取
// ============================================================

function extractEnums(bundles) {
  for (const bundle of bundles) {
    const content = bundle.content

    // 模式: setEnumType(VarName, "pkg.EnumName", [{no:0,name:"VALUE"}, ...])
    const enumRx = /setEnumType\((\w+)\s*,\s*"([^"]+)"\s*,\s*\[/g
    let m

    while ((m = enumRx.exec(content)) !== null) {
      const varName = m[1]
      const fullName = m[2]

      // 如果已经提取了，跳过
      if (schema.enums[fullName]) continue

      // 使用 bracket-depth counting 提取 values 数组
      const bracketStart = m.index + m[0].length - 1 // 回到 [ 的位置
      const valuesStr = extractBracketContent(content, bracketStart)
      if (valuesStr === null) continue

      // 解析 enum values: {no:0,name:"VALUE"} 或 {no:0,name:"VALUE",localName:"value"}
      const valueRx = /\{[^}]*?no:\s*(-?\d+)[^}]*?name:\s*"([^"]+)"[^}]*?\}/g
      let vm
      const values = []
      while ((vm = valueRx.exec(valuesStr)) !== null) {
        values.push({
          number: parseInt(vm[1]),
          name: vm[2],
        })
      }

      schema.enums[fullName] = {
        varName,
        values: values.sort((a, b) => a.number - b.number),
        sourceBundle: bundle.basename,
      }
    }
  }

  if (VERBOSE) console.log(`[ENUM] Enums: ${Object.keys(schema.enums).length}`)
}

// ============================================================
// Phase 5: Service 提取
// ============================================================

function extractServices(bundles) {
  for (const bundle of bundles) {
    const content = bundle.content

    // 步骤 1: 找到所有 method 定义的位置
    const methodRx = /\{name:"(\w+)",I:(\w+),O:(\w+),kind:(\d+)\}/g
    let m
    const methodLocations = []

    while ((m = methodRx.exec(content)) !== null) {
      methodLocations.push({
        name: m[1],
        inputVar: m[2],
        outputVar: m[3],
        kind: parseInt(m[4]),
        index: m.index,
      })
    }

    if (methodLocations.length === 0) continue

    // 步骤 2: 按位置聚类（相邻的 method 属于同一 service）
    const groups = []
    let current = [methodLocations[0]]

    for (let i = 1; i < methodLocations.length; i++) {
      if (methodLocations[i].index - current[current.length - 1].index < 500) {
        current.push(methodLocations[i])
      } else {
        groups.push(current)
        current = [methodLocations[i]]
      }
    }
    groups.push(current)

    // 步骤 3: 为每组找到 service typeName
    for (const group of groups) {
      const firstIdx = group[0].index
      const before = content.substring(Math.max(0, firstIdx - 300), firstIdx)
      const tnMatch = before.match(/typeName:"([^"]+)"/)
      const serviceName = tnMatch
        ? tnMatch[1]
        : `unknown_service_${Object.keys(schema.services).length}`

      if (schema.services[serviceName]) continue

      // 步骤 4: 解析每个 method，解引用 I/O 变量名
      const bundleKey = bundle.basename || bundle.path || "unknown"
      const methods = group.map((m) => ({
        name: m.name,
        inputType: resolveVarInBundle(bundleKey, m.inputVar) || m.inputVar,
        outputType: resolveVarInBundle(bundleKey, m.outputVar) || m.outputVar,
        inputVar: m.inputVar,
        outputVar: m.outputVar,
        kind: METHOD_KINDS[m.kind] || `kind_${m.kind}`,
      }))

      schema.services[serviceName] = {
        methods,
        sourceBundle: bundle.basename,
      }
    }
  }

  if (VERBOSE) {
    const svcCount = Object.keys(schema.services).length
    const methodCount = Object.values(schema.services).reduce(
      (sum, s) => sum + s.methods.length,
      0
    )
    console.log(`[SVC] Services: ${svcCount}, Methods: ${methodCount}`)
  }
}

// ============================================================
// Phase 6: 类型解引用
// ============================================================

function resolveTypes() {
  // 遍历所有 message 的所有字段，解引用 T 值
  for (const [msgName, msgDef] of Object.entries(schema.messages)) {
    const bundleKey = msgDef.sourceBundle
    for (const field of msgDef.fields) {
      if (field.kind === "scalar" && field.T) {
        const num = parseInt(field.T)
        if (!isNaN(num)) {
          field.resolvedType = SCALAR_TYPES[num] || `scalar_${field.T}`
        }
      } else if (field.kind === "message" && field.T) {
        field.resolvedType = resolveVarInBundle(bundleKey, field.T) || field.T
      } else if (field.kind === "enum" && field.T) {
        // enum 字段的 T 通常是 b.getEnumType(VarName) 调用的结果
        // 但在 minified 代码中直接存的是 var 引用
        field.resolvedType = resolveVarInBundle(bundleKey, field.T) || field.T
      } else if (field.kind === "map") {
        // map key
        if (field.mapKeyType !== undefined) {
          field.resolvedMapKeyType =
            SCALAR_TYPES[field.mapKeyType] || `scalar_${field.mapKeyType}`
        }
        // map value
        if (field.mapValueType) {
          if (field.mapValueType.kind === "scalar" && field.mapValueType.T) {
            const num = parseInt(field.mapValueType.T)
            if (!isNaN(num)) {
              field.resolvedMapValueType =
                SCALAR_TYPES[num] || `scalar_${field.mapValueType.T}`
            }
          } else if (
            field.mapValueType.kind === "message" &&
            field.mapValueType.T
          ) {
            field.resolvedMapValueType =
              resolveVarInBundle(bundleKey, field.mapValueType.T) ||
              field.mapValueType.T
          } else if (
            field.mapValueType.kind === "enum" &&
            field.mapValueType.T
          ) {
            field.resolvedMapValueType =
              resolveVarInBundle(bundleKey, field.mapValueType.T) ||
              field.mapValueType.T
          }
        }
      }
    }
  }
}

// ============================================================
// Phase 7: 统计
// ============================================================

function computeStats() {
  const messages = Object.keys(schema.messages)
  const messagesWithFields = messages.filter((k) => !schema.messages[k].isEmpty)
  const enums = Object.keys(schema.enums)
  const services = Object.keys(schema.services)
  const totalMethods = Object.values(schema.services).reduce(
    (sum, s) => sum + s.methods.length,
    0
  )

  // 按 package 分组统计
  const packageStats = {}
  const addToPackage = (fullName, type) => {
    const parts = fullName.split(".")
    const pkg = parts.slice(0, -1).join(".")
    if (!packageStats[pkg]) {
      packageStats[pkg] = { messages: 0, enums: 0, services: 0, methods: 0 }
    }
    packageStats[pkg][type]++
  }
  messages.forEach((n) => addToPackage(n, "messages"))
  enums.forEach((n) => addToPackage(n, "enums"))
  services.forEach((n) => {
    addToPackage(n, "services")
    packageStats[n.split(".").slice(0, -1).join(".")].methods +=
      schema.services[n].methods.length
  })

  // 未解引用的类型（仍然是混淆变量名）
  let unresolvedCount = 0
  for (const msgDef of Object.values(schema.messages)) {
    const bundleKey = msgDef.sourceBundle
    for (const field of msgDef.fields) {
      if (
        (field.kind === "message" || field.kind === "enum") &&
        field.T &&
        !resolveVarInBundle(bundleKey, field.T) &&
        isNaN(parseInt(field.T))
      ) {
        unresolvedCount++
      }
    }
  }

  schema.stats = {
    totalMessages: messages.length,
    messagesWithFields: messagesWithFields.length,
    emptyMessages: messages.length - messagesWithFields.length,
    totalEnums: enums.length,
    totalServices: services.length,
    totalMethods,
    totalVarMappings: Object.keys(schema.varToType).length,
    unresolvedTypeRefs: unresolvedCount,
    packageStats,
  }

  return schema.stats
}

// ============================================================
// Phase 8: Proto 文件生成
// ============================================================

function resolveFieldType(field) {
  if (field.kind === "scalar") {
    return field.resolvedType || `unknown_scalar`
  } else if (field.kind === "message") {
    return field.resolvedType || field.T || "unknown_message"
  } else if (field.kind === "enum") {
    return field.resolvedType || field.T || "unknown_enum"
  } else if (field.kind === "map") {
    const keyType = field.resolvedMapKeyType || `scalar_${field.mapKeyType}`
    let valueType
    if (field.resolvedMapValueType) {
      valueType = field.resolvedMapValueType
    } else if (field.mapValueType) {
      valueType = field.mapValueType.T || "unknown"
    } else {
      valueType = "unknown"
    }
    return `map<${keyType}, ${valueType}>`
  }
  return "unknown"
}

function shortenTypeName(fullName, currentPkg) {
  // 如果同包，使用短名
  const parts = fullName.split(".")
  const pkg = parts.slice(0, -1).join(".")
  const shortName = parts[parts.length - 1]
  if (pkg === currentPkg) return shortName
  return fullName
}

function generateProtoFile() {
  const lines = []

  lines.push("// ============================================================")
  lines.push("// 自动生成 - Cursor IDE Protobuf Schema")
  lines.push(`// 生成时间: ${schema.metadata.timestamp}`)
  lines.push(
    `// 来源: ${schema.metadata.bundlesScanned.map((b) => b.path).join(", ")}`
  )
  lines.push(
    `// 统计: ${schema.stats.totalMessages} messages, ${schema.stats.totalEnums} enums, ${schema.stats.totalServices} services (${schema.stats.totalMethods} methods)`
  )
  lines.push("// ============================================================")
  lines.push("")
  lines.push('syntax = "proto3";')
  lines.push("")

  // 按 package 分组
  const packageItems = {}

  for (const [name, def] of Object.entries(schema.messages)) {
    const parts = name.split(".")
    const pkg = parts.slice(0, -1).join(".")
    if (FILTER_PKG && pkg !== FILTER_PKG) continue
    if (!packageItems[pkg]) {
      packageItems[pkg] = { messages: [], enums: [], services: [] }
    }
    packageItems[pkg].messages.push({
      name,
      shortName: parts[parts.length - 1],
      def,
    })
  }

  for (const [name, def] of Object.entries(schema.enums)) {
    const parts = name.split(".")
    const pkg = parts.slice(0, -1).join(".")
    if (FILTER_PKG && pkg !== FILTER_PKG) continue
    if (!packageItems[pkg]) {
      packageItems[pkg] = { messages: [], enums: [], services: [] }
    }
    packageItems[pkg].enums.push({
      name,
      shortName: parts[parts.length - 1],
      def,
    })
  }

  for (const [name, def] of Object.entries(schema.services)) {
    const parts = name.split(".")
    const pkg = parts.slice(0, -1).join(".")
    if (FILTER_PKG && pkg !== FILTER_PKG) continue
    if (!packageItems[pkg]) {
      packageItems[pkg] = { messages: [], enums: [], services: [] }
    }
    packageItems[pkg].services.push({
      name,
      shortName: parts[parts.length - 1],
      def,
    })
  }

  // 排序 packages（自定义包优先，google 包靠后）
  const sortedPackages = Object.keys(packageItems).sort((a, b) => {
    if (a.startsWith("google.") && !b.startsWith("google.")) return 1
    if (!a.startsWith("google.") && b.startsWith("google.")) return -1
    return a.localeCompare(b)
  })

  for (const pkg of sortedPackages) {
    const items = packageItems[pkg]
    lines.push("// " + "=".repeat(60))
    lines.push(`// package ${pkg}`)
    lines.push("// " + "=".repeat(60))
    lines.push("")
    lines.push(`package ${pkg};`)
    lines.push("")

    // Enums
    for (const enumItem of items.enums.sort((a, b) =>
      a.shortName.localeCompare(b.shortName)
    )) {
      lines.push(`enum ${enumItem.shortName} {`)
      for (const v of enumItem.def.values) {
        lines.push(`  ${v.name} = ${v.number};`)
      }
      lines.push("}")
      lines.push("")
    }

    // Messages
    for (const msgItem of items.messages.sort((a, b) =>
      a.shortName.localeCompare(b.shortName)
    )) {
      const def = msgItem.def
      if (def.isEmpty) {
        lines.push(`message ${msgItem.shortName} {} // 空 message (无字段定义)`)
        lines.push("")
        continue
      }

      lines.push(`message ${msgItem.shortName} {`)

      // 收集 oneofs
      const oneofFields = {}
      for (const f of def.fields) {
        if (f.oneof) {
          if (!oneofFields[f.oneof]) oneofFields[f.oneof] = []
          oneofFields[f.oneof].push(f)
        }
      }

      // 已通过 oneof 输出的字段
      const oneofOutputted = new Set()

      for (const f of def.fields) {
        if (oneofOutputted.has(f.fieldNumber)) continue

        // 如果是 oneof 的第一个字段，输出整个 oneof 块
        if (f.oneof && oneofFields[f.oneof] && oneofFields[f.oneof][0] === f) {
          lines.push(`  oneof ${f.oneof} {`)
          for (const of_ of oneofFields[f.oneof]) {
            const typeStr = resolveFieldType(of_)
            const shortType =
              of_.kind === "message" || of_.kind === "enum"
                ? shortenTypeName(typeStr, pkg)
                : typeStr
            lines.push(`    ${shortType} ${of_.name} = ${of_.fieldNumber};`)
            oneofOutputted.add(of_.fieldNumber)
          }
          lines.push("  }")
          continue
        }

        if (f.oneof) {
          // 此字段已在 oneof 块中输出
          continue
        }

        let typeStr = resolveFieldType(f)

        // map 类型不需要 repeated 前缀
        if (f.kind === "map") {
          lines.push(`  ${typeStr} ${f.name} = ${f.fieldNumber};`)
          continue
        }

        // 解引用后缩短类型名
        if (f.kind === "message" || f.kind === "enum") {
          typeStr = shortenTypeName(typeStr, pkg)
        }

        const modifiers = []
        if (f.repeated) modifiers.push("repeated")
        if (f.optional) modifiers.push("optional")
        if (f.required) modifiers.push("required")

        const prefix = modifiers.length ? modifiers.join(" ") + " " : ""

        const comments = []
        if (f.packed) comments.push("packed")
        if (f.defaultValue !== undefined)
          comments.push(`default=${f.defaultValue}`)
        // 如果类型是未解引用的混淆名，添加注释
        if (
          (f.kind === "message" || f.kind === "enum") &&
          f.T &&
          !schema.varToType[f.T]
        ) {
          comments.push(`obfuscated: ${f.T}`)
        }
        const commentStr = comments.length ? ` // ${comments.join(", ")}` : ""

        lines.push(
          `  ${prefix}${typeStr} ${f.name} = ${f.fieldNumber};${commentStr}`
        )
      }

      lines.push("}")
      lines.push("")
    }

    // Services
    for (const svcItem of items.services.sort((a, b) =>
      a.shortName.localeCompare(b.shortName)
    )) {
      lines.push(`service ${svcItem.shortName} {`)
      for (const m of svcItem.def.methods) {
        const inputShort = shortenTypeName(m.inputType, pkg)
        const outputShort = shortenTypeName(m.outputType, pkg)
        const kindComment = m.kind !== "unary" ? ` // ${m.kind}` : ""

        let rpcStr
        if (m.kind === "server_streaming") {
          rpcStr = `  rpc ${m.name} (${inputShort}) returns (stream ${outputShort});${kindComment}`
        } else if (m.kind === "client_streaming") {
          rpcStr = `  rpc ${m.name} (stream ${inputShort}) returns (${outputShort});${kindComment}`
        } else if (m.kind === "bidi_streaming") {
          rpcStr = `  rpc ${m.name} (stream ${inputShort}) returns (stream ${outputShort});${kindComment}`
        } else {
          rpcStr = `  rpc ${m.name} (${inputShort}) returns (${outputShort});`
        }
        lines.push(rpcStr)
      }
      lines.push("}")
      lines.push("")
    }
  }

  return lines.join("\n")
}

// ============================================================
// Phase 9: 报告生成
// ============================================================

function generateReport(stats) {
  const lines = []
  lines.push("=".repeat(60))
  lines.push("Cursor Protobuf Schema 提取报告")
  lines.push("=".repeat(60))
  lines.push("")
  lines.push(`生成时间: ${schema.metadata.timestamp}`)
  lines.push(`扫描 Bundles: ${schema.metadata.bundlesScanned.length}`)
  lines.push("")
  lines.push("--- 核心统计 ---")
  lines.push(`Messages (总计):    ${stats.totalMessages}`)
  lines.push(`  - 有字段:          ${stats.messagesWithFields}`)
  lines.push(`  - 空 message:      ${stats.emptyMessages}`)
  lines.push(`Enums:              ${stats.totalEnums}`)
  lines.push(`Services:           ${stats.totalServices}`)
  lines.push(`RPC Methods:        ${stats.totalMethods}`)
  lines.push(`Var→Type 映射:     ${stats.totalVarMappings}`)
  lines.push(`未解引用的类型:    ${stats.unresolvedTypeRefs}`)
  lines.push("")
  lines.push("--- 按 Package 分布 ---")

  Object.entries(stats.packageStats)
    .filter(([pkg]) => !FILTER_PKG || pkg === FILTER_PKG)
    .sort((a, b) => {
      const totalA = a[1].messages + a[1].enums + a[1].services
      const totalB = b[1].messages + b[1].enums + b[1].services
      return totalB - totalA
    })
    .forEach(([pkg, s]) => {
      const parts = []
      if (s.messages) parts.push(`${s.messages} msg`)
      if (s.enums) parts.push(`${s.enums} enum`)
      if (s.services) parts.push(`${s.services} svc (${s.methods} methods)`)
      lines.push(`  ${pkg}: ${parts.join(", ")}`)
    })

  lines.push("")
  lines.push("--- Bundle 来源 ---")
  schema.metadata.bundlesScanned.forEach((b) => {
    lines.push(`  ${b.path}: ${b.sizeMB} MB`)
  })

  return lines.join("\n")
}

// ============================================================
// Main
// ============================================================

function main() {
  console.log("=".repeat(60))
  console.log("Cursor Protobuf Schema 完整提取器")
  console.log("=".repeat(60))
  console.log("")

  // Phase 1: 加载
  console.log("[1/7] 加载 Bundle 文件...")
  const bundles = loadBundles()
  if (bundles.length === 0) {
    console.error("ERROR: 未找到任何 Cursor bundle 文件")
    process.exit(1)
  }

  // Phase 2: 建立映射
  console.log("[2/7] 建立 VarName → TypeName 映射...")
  buildVarTypeMapping(bundles)

  // Phase 3: 提取 Messages
  console.log("[3/7] 提取 Message 定义...")
  extractMessages(bundles)

  // Phase 4: 提取 Enums
  console.log("[4/7] 提取 Enum 定义...")
  extractEnums(bundles)

  // Phase 5: 提取 Services
  console.log("[5/7] 提取 Service 定义...")
  extractServices(bundles)

  // Phase 6: 类型解引用
  console.log("[6/7] 解引用混淆类型名...")
  resolveTypes()

  // Phase 7: 统计
  console.log("[7/7] 生成统计和输出...")
  const stats = computeStats()

  // 输出
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  // 报告
  const report = generateReport(stats)
  console.log("")
  console.log(report)

  const reportPath = path.join(OUTPUT_DIR, "extraction_report.txt")
  fs.writeFileSync(reportPath, report)
  console.log(`\n报告: ${reportPath}`)

  if (!STATS_ONLY) {
    // Proto 文件
    const protoContent = generateProtoFile()
    const protoPath = path.join(OUTPUT_DIR, "cursor.proto")
    fs.writeFileSync(protoPath, protoContent)
    console.log(`Proto: ${protoPath}`)

    // JSON
    if (OUTPUT_JSON) {
      const jsonPath = path.join(OUTPUT_DIR, "cursor_schema.json")

      // 移除 content/source 等大字段，输出精简 JSON
      const jsonOutput = {
        metadata: schema.metadata,
        stats: schema.stats,
        messages: {},
        enums: schema.enums,
        services: schema.services,
        varToType: schema.varToType,
        varToTypeByBundle: schema.varToTypeByBundle,
      }
      // 精简 message 输出（去掉 sourceBundle）
      for (const [name, def] of Object.entries(schema.messages)) {
        jsonOutput.messages[name] = {
          fields: def.fields,
          sourceBundle: def.sourceBundle,
          isEmpty: def.isEmpty,
        }
      }
      fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2))
      console.log(`JSON:  ${jsonPath}`)
    }
  }

  console.log("")
  console.log("=".repeat(60))
  console.log("提取完成！")
  console.log("=".repeat(60))
}

main()

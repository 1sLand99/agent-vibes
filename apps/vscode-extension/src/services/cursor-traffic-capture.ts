export type CursorTrafficCaptureRule = {
  name: string
  marker: string
  anchors: string[]
  find: RegExp
  replace: string
}

export type CursorTrafficCaptureDetails = {
  applied: boolean
  partial: boolean
  canApply: boolean
  totalRules: number
  appliedRuleNames: string[]
  availableRuleNames: string[]
  missingRuleNames: string[]
}

type CursorTrafficCaptureMatch = {
  start: number
  end: number
  replacement: string
}

const LOCAL_SEARCH_RADIUS_BYTES = 256 * 1024

export const CURSOR_TRAFFIC_CAPTURE_RULES: readonly CursorTrafficCaptureRule[] =
  [
    {
      name: "Transport Request Initiation",
      marker: "[TRANSPORT_REQUEST]",
      anchors: ["Initiating stream AI connect"],
      find: /this\.structuredLogService\.debug\("transport","Initiating stream AI connect",\{service:([A-Za-z_$][\w$]*)\.typeName,method:([A-Za-z_$][\w$]*)\.name,streamId:([A-Za-z_$][\w$]*),requestId:([A-Za-z_$][\w$]*)\?\?"not-found"/u,
      replace:
        'console.warn("[TRANSPORT_REQUEST]",JSON.stringify({service:$1.typeName,method:$2.name,streamId:$3,requestId:$4,requestType:$2.I?.typeName,responseType:$2.O?.typeName})),this.structuredLogService.debug("transport","Initiating stream AI connect",{service:$1.typeName,method:$2.name,streamId:$3,requestId:$4??"not-found"',
    },
    {
      name: "Transport Request Payload",
      marker: "[TRANSPORT_REQUEST_PAYLOAD]",
      anchors: [
        "Initiating stream AI connect",
        "$callAiConnectTransportProviderStream",
      ],
      find: /const ([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\.I\(([A-Za-z_$][\w$]*)\);([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.wrap\(\1\.toBinary\(\)\)/u,
      replace:
        'const $1=new $2.I($3);(()=>{try{console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:$2.I?.typeName,payload:$1.toJson?$1.toJson():$3}))}catch(xErr){console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:$2.I?.typeName,error:String(xErr)}))}})();$4=$5.wrap($1.toBinary())',
    },
    {
      name: "Transport Response Chunk",
      marker: "[TRANSPORT_CHUNK]",
      anchors: ["$pushAiConnectTransportStreamChunk"],
      find: /this\._proxy\.\$pushAiConnectTransportStreamChunk\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/u,
      replace:
        '(console.warn("[TRANSPORT_CHUNK]",JSON.stringify({streamId:$2,chunkSize:$1?.length||0,chunkB64:$1?btoa(String.fromCharCode.apply(null,$1.slice(0,2000))):null})),this._proxy.$pushAiConnectTransportStreamChunk($1,$2,$3))',
    },
    {
      name: "Transport Response Yield",
      marker: "[TRANSPORT_RESPONSE]",
      anchors: ["$callAiConnectTransportProviderStream"],
      find: /for await\(const ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{if\(([A-Za-z_$][\w$]*)\.token\.isCancellationRequested\)continue;yield ([A-Za-z_$][\w$]*)\.O\.fromBinary\(\1\.buffer\)\}/u,
      replace:
        'for await(const $1 of $2){if($3.token.isCancellationRequested)continue;const xResp=$4.O.fromBinary($1.buffer);(()=>{try{console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:$4.O?.typeName,payload:xResp.toJson?xResp.toJson():xResp}))}catch(xErr){console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:$4.O?.typeName,error:String(xErr)}))}})();yield xResp}',
    },
    {
      name: "Transport Call Complete",
      marker: "[TRANSPORT_STREAM_STARTED]",
      anchors: ["$callAiConnectTransportProviderStream"],
      find: /const ([A-Za-z_$][\w$]*)=await this\._proxy\.\$callAiConnectTransportProviderStream\(([A-Za-z_$][\w$]*),\(([A-Za-z_$][\w$]*)\.typeName in ([A-Za-z_$][\w$]*),\3\.typeName\),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.name\),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.token\),([A-Za-z_$][\w$]*)=this\._streamIdToAsyncReturnQueue/u,
      replace:
        'const $1=(console.warn("[TRANSPORT_STREAM_STARTED]",JSON.stringify({streamId:$2,service:$3.typeName,method:$6.name,headers:$8})),await this._proxy.$callAiConnectTransportProviderStream($2,($3.typeName in $4,$3.typeName),$5($6.name),$7,$8,$9,$10.token)),$11=this._streamIdToAsyncReturnQueue',
    },
    {
      name: "Unary Request Payload",
      marker: "[UNARY_REQUEST]",
      anchors: ["$callAiConnectTransportProviderUnary"],
      find: /const ([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\.I\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.wrap\(\1\.toBinary\(\)\);if\(!\(([A-Za-z_$][\w$]*)\.typeName in/u,
      replace:
        'const $1=new $2.I($3),$4=$5.wrap($1.toBinary());(()=>{try{const svc=$6.typeName,mth=$2.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_REQUEST]",JSON.stringify({service:svc,method:mth,type:$2.I?.typeName,payload:$1.toJson?$1.toJson():$3}))}catch(xErr){console.warn("[UNARY_REQUEST]",JSON.stringify({service:$6.typeName,method:$2.name,type:$2.I?.typeName,error:String(xErr)}))}})();if(!($6.typeName in',
    },
    {
      name: "Unary Response",
      marker: "[UNARY_RESPONSE]",
      anchors: ["$callAiConnectTransportProviderUnary"],
      find: /const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.message,([A-Za-z_$][\w$]*)=\2\.header,([A-Za-z_$][\w$]*)=\2\.trailer,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.O\.fromBinary\(\1\);return\{service:([A-Za-z_$][\w$]*),method:\6/u,
      replace:
        'const $1=$2.message,$3=$2.header,$4=$2.trailer,$5=$6.O.fromBinary($1);(()=>{try{const svc=$7.typeName,mth=$6.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_RESPONSE]",JSON.stringify({service:svc,method:mth,type:$6.O?.typeName,payload:$5.toJson?$5.toJson():$5}))}catch(xErr){console.warn("[UNARY_RESPONSE]",JSON.stringify({service:$7.typeName,method:$6.name,type:$6.O?.typeName,error:String(xErr)}))}})();return{service:$7,method:$6',
    },
    {
      name: "Unary Call Started",
      marker: "[UNARY_CALL_STARTED]",
      anchors: ["$callAiConnectTransportProviderUnary"],
      find: /const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.typeName,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.name\),([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\.\$callAiConnectTransportProviderUnary\(\1,\3,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.token\)/u,
      replace:
        'const $1=$2.typeName,$3=$4($5.name);const xSkip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(!xSkip.includes($5.name)){console.warn("[UNARY_CALL_STARTED]",JSON.stringify({service:$1,method:$5.name,headers:$10}))}const $6=await $7.$callAiConnectTransportProviderUnary($1,$3,$8,$9,$10,$11.token)',
    },
  ]

export const CURSOR_TRAFFIC_CAPTURE_MARKERS = CURSOR_TRAFFIC_CAPTURE_RULES.map(
  (rule) => rule.marker
)

function createSearchPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, ""))
}

function findRuleMatch(
  content: string,
  rule: CursorTrafficCaptureRule
): CursorTrafficCaptureMatch | null {
  const searchedRanges = new Set<string>()

  for (const anchor of rule.anchors) {
    let anchorIndex = content.indexOf(anchor)
    while (anchorIndex >= 0) {
      const start = Math.max(0, anchorIndex - LOCAL_SEARCH_RADIUS_BYTES)
      const end = Math.min(
        content.length,
        anchorIndex + anchor.length + LOCAL_SEARCH_RADIUS_BYTES
      )
      const rangeKey = `${start}:${end}`
      if (!searchedRanges.has(rangeKey)) {
        searchedRanges.add(rangeKey)
        const window = content.slice(start, end)
        const pattern = createSearchPattern(rule.find)
        const match = pattern.exec(window)
        if (match) {
          return {
            start: start + match.index,
            end: start + match.index + match[0].length,
            replacement: match[0].replace(pattern, rule.replace),
          }
        }
      }
      anchorIndex = content.indexOf(anchor, anchorIndex + anchor.length)
    }
  }

  return null
}

function getAppliedMarkers(content: string): Set<string> {
  const applied = new Set<string>()
  const markerPattern =
    /\[(?:TRANSPORT_REQUEST|TRANSPORT_REQUEST_PAYLOAD|TRANSPORT_CHUNK|TRANSPORT_RESPONSE|TRANSPORT_STREAM_STARTED|UNARY_REQUEST|UNARY_RESPONSE|UNARY_CALL_STARTED)\]/gu
  let match: RegExpExecArray | null
  while ((match = markerPattern.exec(content)) !== null) {
    applied.add(match[0])
  }
  return applied
}

export function getCursorTrafficCaptureDetails(
  content: string
): CursorTrafficCaptureDetails {
  const appliedMarkers = getAppliedMarkers(content)
  const appliedRuleNames: string[] = []
  const availableRuleNames: string[] = []
  const missingRuleNames: string[] = []

  for (const rule of CURSOR_TRAFFIC_CAPTURE_RULES) {
    if (appliedMarkers.has(rule.marker)) {
      appliedRuleNames.push(rule.name)
    } else if (findRuleMatch(content, rule)) {
      availableRuleNames.push(rule.name)
    } else {
      missingRuleNames.push(rule.name)
    }
  }

  const applied =
    appliedRuleNames.length === CURSOR_TRAFFIC_CAPTURE_RULES.length
  return {
    applied,
    partial: appliedRuleNames.length > 0 && !applied,
    canApply: missingRuleNames.length === 0,
    totalRules: CURSOR_TRAFFIC_CAPTURE_RULES.length,
    appliedRuleNames,
    availableRuleNames,
    missingRuleNames,
  }
}

export function patchCursorTrafficCaptureContent(
  content: string
): string | null {
  return patchCursorTrafficCaptureRules(
    content,
    CURSOR_TRAFFIC_CAPTURE_RULES.map((rule) => rule.name)
  )
}

export function patchCursorTrafficCaptureRules(
  content: string,
  ruleNames: readonly string[]
): string | null {
  let nextContent = content
  const appliedMarkers = getAppliedMarkers(content)
  const selectedRuleNames = new Set(ruleNames)

  for (const rule of CURSOR_TRAFFIC_CAPTURE_RULES) {
    if (!selectedRuleNames.has(rule.name)) continue
    if (appliedMarkers.has(rule.marker)) continue
    const match = findRuleMatch(nextContent, rule)
    if (!match) return null
    nextContent =
      nextContent.slice(0, match.start) +
      match.replacement +
      nextContent.slice(match.end)
    appliedMarkers.add(rule.marker)
  }

  return CURSOR_TRAFFIC_CAPTURE_RULES.filter((rule) =>
    selectedRuleNames.has(rule.name)
  ).every((rule) => nextContent.includes(rule.marker))
    ? nextContent
    : null
}

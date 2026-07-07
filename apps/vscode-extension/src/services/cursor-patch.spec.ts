import {
  normalizeCursorApplicationUserEntitlementValue,
  normalizeCursorApplicationUserEndpointValue,
  patchBridgeEndpointContent,
} from "./cursor-patch"

const BRIDGE_URL = "https://localhost:2026"
const MODULE_ID =
  '"out-build/vs/platform/reactivestorage/browser/reactiveStorageService.js"'

function buildFreshWorkbenchContent(): string {
  return [
    MODULE_ID,
    'cursorCreds:{websiteUrl:"https://www.cursor.com",backendUrl:"https://api2.cursor.sh",repoBackendUrl:"https://repo42.cursor.sh",cppBackendUrl:"https://api5.cursor.sh",telemBackendUrl:"https://api2.cursor.sh",cmdkBackendUrl:"https://api2.cursor.sh",geoCppBackendUrl:"https://api2geo.cursor.sh",cppConfigBackendUrl:"https://api5.cursor.sh",bcProxyUrl:"https://api2.cursor.sh",agentBackendUrlPrivacy:{default:"https://agentn.api5.cursor.sh"},agentBackendUrlNonPrivacy:{default:"https://agentn.api5.cursor.sh"},credentialsDisplayName:"Prod"},A=[(e,t)=>t]',
    "class C{getEffectiveCredentials(){const e=this.reactiveStorageService.applicationUserPersistentStorage.cursorCreds,t=this.testBackendUrlOverride;if(!t)return e;const n=this.getAgentBackendUrls(t);return{...e,backendUrl:t,repoBackendUrl:t,telemBackendUrl:t,geoCppBackendUrl:t,cppConfigBackendUrl:t,cmdkBackendUrl:t,bcProxyUrl:t,agentBackendUrlNonPrivacy:n}}}",
  ].join("")
}

function buildOldPatchedWorkbenchContent(): string {
  return [
    MODULE_ID,
    `cursorCreds:{websiteUrl:"https://www.cursor.com",backendUrl:"${BRIDGE_URL}"/*[AGENT_VIBES_CURSOR_BRIDGE_ENDPOINT]*/,repoBackendUrl:"${BRIDGE_URL}",cppBackendUrl:"${BRIDGE_URL}",telemBackendUrl:"${BRIDGE_URL}",cmdkBackendUrl:"${BRIDGE_URL}",geoCppBackendUrl:"${BRIDGE_URL}",cppConfigBackendUrl:"${BRIDGE_URL}",bcProxyUrl:"${BRIDGE_URL}",agentBackendUrlPrivacy:{default:"${BRIDGE_URL}"},agentBackendUrlNonPrivacy:{default:"${BRIDGE_URL}"},credentialsDisplayName:"Prod"},A=[/*[AGENT_VIBES_CURSOR_ENDPOINT_GUARD]*/(e,t)=>{const n="${BRIDGE_URL}",r=t?.cursorCreds;if(!r||typeof r!="object")return t;const a=e=>{const t={...(e||{})};for(const e in t)typeof t[e]=="string"&&(t[e]=n);return t.default=n,t},s={...r,backendUrl:n,cppBackendUrl:n,telemBackendUrl:n,cmdkBackendUrl:n,geoCppBackendUrl:n,cppConfigBackendUrl:n,bcProxyUrl:n,agentBackendUrlPrivacy:a(r.agentBackendUrlPrivacy),agentBackendUrlNonPrivacy:a(r.agentBackendUrlNonPrivacy)};let o={...t,cursorCreds:s};return o.cppConfig&&typeof o.cppConfig=="object"&&typeof o.cppConfig.cppUrl=="string"?{...o,cppConfig:{...o.cppConfig,cppUrl:n}}:o},(e,t)=>t]`,
    `class C{getEffectiveCredentials(){const e=this.reactiveStorageService.applicationUserPersistentStorage.cursorCreds,t=this.testBackendUrlOverride,agentVibesNormalize=/*[AGENT_VIBES_CURSOR_CREDENTIALS_GUARD]*/(base,url="${BRIDGE_URL}")=>({...base,backendUrl:url,cppBackendUrl:url,telemBackendUrl:url,geoCppBackendUrl:url,cppConfigBackendUrl:url,cmdkBackendUrl:url,bcProxyUrl:url,agentBackendUrlPrivacy:{default:url},agentBackendUrlNonPrivacy:{default:url}});if(!t)return agentVibesNormalize(e);const n=this.getAgentBackendUrls(t);return agentVibesNormalize({...e,backendUrl:t,repoBackendUrl:t,telemBackendUrl:t,geoCppBackendUrl:t,cppConfigBackendUrl:t,cmdkBackendUrl:t,bcProxyUrl:t,agentBackendUrlNonPrivacy:n},t)}}`,
  ].join("")
}

describe("Cursor bridge endpoint patch", () => {
  it("normalizes persisted new-agent endpoint fields", () => {
    const applicationUser = {
      cursorCreds: {
        backendUrl: "https://api2.cursor.sh",
        repoBackendUrl: "https://api2.cursor.sh",
        agentUrl: "https://agentn.api5.cursor.sh",
        agentBackendUrlPrivacy: {
          default: "https://agentn.api5.cursor.sh",
        },
        agentBackendUrlNonPrivacy: {
          default: "https://agentn.api5.cursor.sh",
        },
      },
    }

    const result = normalizeCursorApplicationUserEndpointValue(
      JSON.stringify(applicationUser),
      BRIDGE_URL
    )

    expect(result?.changed).toBe(true)
    const next = JSON.parse(result?.value ?? "{}") as {
      cursorCreds: Record<string, unknown>
    }
    expect(next.cursorCreds.backendUrl).toBe(BRIDGE_URL)
    expect(next.cursorCreds.repoBackendUrl).toBe(BRIDGE_URL)
    expect(next.cursorCreds.agentUrl).toBe(BRIDGE_URL)
    expect(next.cursorCreds.agentBackendUrlPrivacy).toMatchObject({
      default: BRIDGE_URL,
    })
    expect(next.cursorCreds.agentBackendUrlNonPrivacy).toMatchObject({
      default: BRIDGE_URL,
    })
  })

  it("injects agentUrl into fresh credential guards", () => {
    const patched = patchBridgeEndpointContent(
      buildFreshWorkbenchContent(),
      2026
    )

    expect(patched).not.toBeNull()
    expect(patched).toContain("repoBackendUrl:url")
    expect(patched).toContain("agentUrl:url")
  })

  it("upgrades old credential guards that predate agentUrl", () => {
    const patched = patchBridgeEndpointContent(
      buildOldPatchedWorkbenchContent(),
      2026
    )

    expect(patched).not.toBeNull()
    expect(patched).toContain("repoBackendUrl:url")
    expect(patched).toContain("agentUrl:url")
    expect(patched).toContain("agentUrl:n")
  })

  it("normalizes local entitlement state used by model gates", () => {
    const result = normalizeCursorApplicationUserEntitlementValue(
      JSON.stringify({
        membershipType: "free",
        subscriptionStatus: "canceled",
        cursorCreds: {},
      })
    )

    expect(result?.changed).toBe(true)
    const next = JSON.parse(result?.value ?? "{}") as {
      membershipType: string
      subscriptionStatus: string
    }
    expect(next.membershipType).toBe("ultra")
    expect(next.subscriptionStatus).toBe("active")
  })
})

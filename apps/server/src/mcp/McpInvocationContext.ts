import {
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type McpCapability = "preview" | "ios-simulator";

/**
 * A local MCP error keeps toolkit capability negotiation separate from the
 * client-facing preview and Simulator RPC contracts.
 */
export class McpCapabilityUnavailableError extends Schema.TaggedErrorClass<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: Schema.Literal("ios-simulator"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

const requireMcpCapabilityImpl = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (invocation.capabilities.has(capability)) return invocation;

  switch (capability) {
    case "ios-simulator":
      return yield* new McpCapabilityUnavailableError({
        capability,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
    case "preview":
      return yield* new PreviewAutomationUnavailableError({
        capability,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
  }
});

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "ios-simulator",
): Effect.Effect<McpInvocationScope, McpCapabilityUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: McpCapability,
): Effect.Effect<
  McpInvocationScope,
  PreviewAutomationUnavailableError | McpCapabilityUnavailableError,
  McpInvocationContext
>;
export function requireMcpCapability(
  capability: McpCapability,
): Effect.Effect<
  McpInvocationScope,
  PreviewAutomationUnavailableError | McpCapabilityUnavailableError,
  McpInvocationContext
> {
  return requireMcpCapabilityImpl(capability);
}

import { describe, expect, it } from "vite-plus/test";
import { Tool } from "effect/unstable/ai";

import { IosSimulatorToolkit } from "./tools.ts";

const automationToolNames = [
  "ios_build_run",
  "ios_launch_app",
  "ios_stop_app",
  "ios_snapshot_ui",
  "ios_screenshot",
  "ios_tap",
  "ios_type_text",
  "ios_wait_for_ui",
  "ios_swipe",
] as const;

const requiredPropertiesByTool = {
  ios_session_close: ["leaseId", "generation"],
  ios_build_run: ["udid", "scheme"],
  ios_launch_app: ["leaseId", "generation", "bundleId"],
  ios_stop_app: ["leaseId", "generation", "bundleId"],
  ios_snapshot_ui: ["leaseId", "generation"],
  ios_screenshot: ["leaseId", "generation"],
  ios_tap: ["leaseId", "generation", "elementRef"],
  ios_type_text: ["leaseId", "generation", "elementRef", "text"],
  ios_wait_for_ui: ["leaseId", "generation", "predicate"],
  ios_swipe: ["leaseId", "generation", "withinElementRef", "direction"],
} as const;

const forbiddenAutomationProperties = [
  "command",
  "args",
  "extraArgs",
  "cwd",
  "workspaceRoot",
  "simulatorId",
  "x",
  "y",
] as const;

describe("IosSimulatorToolkit", () => {
  it("exports described object schemas for every simulator tool", () => {
    for (const tool of Object.values(IosSimulatorToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool) as {
        readonly type?: unknown;
        readonly properties?: Readonly<Record<string, unknown>>;
      };
      expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(40);
      if (tool.name === "ios_capabilities" || tool.name === "ios_list_simulators") continue;
      expect(schema.type, `${tool.name} root schema`).toBe("object");
      if (tool.name === "ios_session_status") {
        expect(schema.properties?.leaseId, `${tool.name} leaseId`).toBeDefined();
        continue;
      }
      if (tool.name === "ios_build_run") {
        expect(schema.properties?.udid, `${tool.name} udid`).toBeDefined();
        expect(schema.properties?.leaseId, `${tool.name} leaseId`).toBeUndefined();
        expect(schema.properties?.generation, `${tool.name} generation`).toBeUndefined();
        continue;
      }
      expect(schema.properties?.leaseId, `${tool.name} leaseId`).toBeDefined();
      expect(schema.properties?.generation, `${tool.name} generation`).toBeDefined();
    }
  });

  it("advertises object output schemas for every simulator tool", () => {
    for (const tool of Object.values(IosSimulatorToolkit.tools)) {
      const schema = Tool.getJsonSchemaFromSchema(tool.successSchema) as {
        readonly type?: unknown;
      };
      expect(schema.type, `${tool.name} output schema`).toBe("object");
    }
  });

  it("requires lease identity and tool-specific inputs", () => {
    for (const toolName of Object.keys(requiredPropertiesByTool) as Array<
      keyof typeof requiredPropertiesByTool
    >) {
      const expectedRequired = requiredPropertiesByTool[toolName];
      const schema = Tool.getJsonSchema(IosSimulatorToolkit.tools[toolName]) as {
        readonly required?: ReadonlyArray<string>;
      };
      for (const property of expectedRequired) {
        expect(schema.required, `${toolName} required properties`).toContain(property);
      }
    }
  });

  it("keeps agent UI automation semantic and coordinate-free", () => {
    for (const toolName of automationToolNames) {
      const tool = IosSimulatorToolkit.tools[toolName];
      const schema = Tool.getJsonSchema(tool) as {
        readonly properties?: Readonly<Record<string, unknown>>;
      };
      const propertyNames = Object.keys(schema.properties ?? {});
      for (const property of forbiddenAutomationProperties) {
        expect(propertyNames, `${toolName} must not accept ${property}`).not.toContain(property);
      }
      expect(propertyNames, `${toolName} must not accept simulator UDID`).toEqual(
        toolName === "ios_build_run"
          ? expect.arrayContaining(["udid"])
          : expect.not.arrayContaining(["udid"]),
      );
    }

    const buildRunProperties = Object.keys(
      (
        Tool.getJsonSchema(IosSimulatorToolkit.tools.ios_build_run) as {
          readonly properties?: Readonly<Record<string, unknown>>;
        }
      ).properties ?? {},
    );
    expect(buildRunProperties).not.toContain("extraArgs");

    const tapProperties = Object.keys(
      (
        Tool.getJsonSchema(IosSimulatorToolkit.tools.ios_tap) as {
          readonly properties?: Readonly<Record<string, unknown>>;
        }
      ).properties ?? {},
    );
    expect(tapProperties).toContain("elementRef");

    const swipeProperties = Object.keys(
      (
        Tool.getJsonSchema(IosSimulatorToolkit.tools.ios_swipe) as {
          readonly properties?: Readonly<Record<string, unknown>>;
        }
      ).properties ?? {},
    );
    expect(swipeProperties).toContain("withinElementRef");
  });

  it("requires a build before it can create an agent-facing simulator lease", () => {
    expect(Object.keys(IosSimulatorToolkit.tools)).not.toContain("ios_session_open");

    const buildRunSchema = Tool.getJsonSchema(IosSimulatorToolkit.tools.ios_build_run) as {
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: ReadonlyArray<string>;
    };
    expect(buildRunSchema.required).toEqual(expect.arrayContaining(["udid", "scheme"]));
    expect(buildRunSchema.required).not.toEqual(expect.arrayContaining(["leaseId", "generation"]));
    expect(buildRunSchema.properties?.leaseId).toBeUndefined();
    expect(buildRunSchema.properties?.generation).toBeUndefined();
  });
});

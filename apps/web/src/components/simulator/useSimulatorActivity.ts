import type { ScopedThreadRef, SimulatorEvent, SimulatorSession } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { simulatorEnvironment } from "~/state/simulator";

function eventThreadId(event: SimulatorEvent): string {
  return event.type === "session" ? event.session.threadId : event.threadId;
}

function leaseKey(session: SimulatorSession): string {
  return `${session.leaseId}:${session.generation}`;
}

export interface SimulatorActivity {
  readonly session: SimulatorSession | null;
  readonly deviceLabel: string;
}

/**
 * Keeps Simulator lifecycle discovery alive even while its right-panel surface
 * is closed. A lease gets one automatic reveal; closing it manually stays
 * respected until a later lease is acquired.
 */
export function useSimulatorActivity(threadRef: ScopedThreadRef | null): SimulatorActivity {
  const statusQuery = useEnvironmentQuery(
    threadRef
      ? simulatorEnvironment.status({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const eventsQuery = useEnvironmentQuery(
    threadRef
      ? simulatorEnvironment.events({ environmentId: threadRef.environmentId, input: {} })
      : null,
  );
  const session = statusQuery.data?.session ?? null;
  const listQuery = useEnvironmentQuery(
    threadRef && session
      ? simulatorEnvironment.list({ environmentId: threadRef.environmentId, input: {} })
      : null,
  );
  const event = eventsQuery.data;
  useEffect(() => {
    if (!threadRef || !event || eventThreadId(event) !== threadRef.threadId) return;
    statusQuery.refresh();
    if (event.type === "session") listQuery.refresh();
  }, [event, listQuery.refresh, statusQuery.refresh, threadRef]);

  useEffect(() => {
    if (!threadRef || !session) return;
    const key = leaseKey(session);
    useRightPanelStore.getState().ensureSimulatorSurface(threadRef, key);
  }, [session, threadRef]);

  const deviceLabel = useMemo(() => {
    if (!session) return "iOS Simulator";
    const device = listQuery.data?.devices.find((candidate) => candidate.udid === session.udid);
    return device?.name ?? "iOS Simulator";
  }, [listQuery.data?.devices, session]);

  return { session, deviceLabel };
}

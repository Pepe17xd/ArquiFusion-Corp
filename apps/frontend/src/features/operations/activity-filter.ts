import type { OperationalItem } from "../../services/api/client";

export function filterAuditEvents(items: OperationalItem[], filters: { from: string; to: string; type: string; status: string; search: string }) {
  const search = filters.search.toLowerCase();
  const status = filters.status.toLowerCase();
  return items.filter((event) => {
    const stamp = String(event.timestamp ?? event.createdAt ?? "");
    const day = stamp.slice(0, 10);
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const eventStatus = String(event.status ?? payload.status ?? "");
    const haystack = `${event.entityId} ${event.eventId ?? ""} ${event.resourceId ?? ""} ${event.machineId ?? ""} ${event.eventType ?? ""} ${JSON.stringify(payload)}`.toLowerCase();
    return (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to) && (!filters.type || event.eventType === filters.type) && (!status || eventStatus.toLowerCase().includes(status)) && (!search || haystack.includes(search));
  });
}

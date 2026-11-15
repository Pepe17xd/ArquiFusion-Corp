import type { ReactNode } from "react";
import { EmptyState } from "./DesignPrimitives";

export function DataTable<T extends { entityId: string }>({ items, headers, empty, render }: {
  items: T[];
  headers: string[];
  empty: string;
  render: (item: T) => ReactNode[];
}) {
  return <div className="module-table-wrap"><table className="module-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{items.map((item) => <tr key={item.entityId}>{render(item).map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table>{!items.length && <EmptyState title="Sin registros" description={empty}/>}</div>;
}

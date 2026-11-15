export function paginate<T>(items: T[], requestedPage: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(1, Math.min(requestedPage, pages));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pages, total: items.length };
}

export function isPublicRoute(pathname: string): boolean {
  return pathname === "/";
}

export function shouldRedirectRestoredRoute(persisted: boolean, authenticated: boolean, pathname: string): boolean {
  return persisted && !authenticated && !isPublicRoute(pathname);
}

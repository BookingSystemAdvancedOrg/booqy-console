export function isDevBuild(o: {
  command?: string
  mode?: string
  environment?: string
  apiBaseUrl?: string
  devApiBaseUrl?: string
}): boolean
export function readDevApiBaseUrl(repoRoot: string): string | undefined
export function maskableTile(side: number, badge: { inset: number; width: number; height: number }): { x: number; y: number; size: number }
export function faviconBadgeSvg(svg: string, letterColour: string, devIcon: unknown): string
export function buildDevFiles(o: { publicDir: string; assetsDir: string; devIconPath: string }): Record<string, Uint8Array>
export function devIndexHtml(html: string): string
export function devBadgePlugin(o: {
  root: string
  devIconPath: string
  decide: (command: 'build' | 'serve', mode: string) => boolean
}): import('vite').Plugin

import type { HelpCorpus } from '../src/features/help/kb'
export const SENSITIVE: RegExp
export function helpSlug(text: string): string
export function buildCorpus(): HelpCorpus
export function parseNav(): { to: string; label: string }[]
export function helpCorpusPlugin(): import('vite').Plugin

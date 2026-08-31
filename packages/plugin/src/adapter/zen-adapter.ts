/**
 * Compatibility entry point for integrations that imported the reference
 * adapter by filename. Runtime traffic is now routed through Kilo.
 */
export { KiloAdapter as ZenAdapter, createKiloAdapter as createZenAdapter, PROVIDER_ID } from './kilo-adapter.ts'
export type { KiloAdapterOptions, CatalogLike } from './kilo-adapter.ts'
export type { KiloModelInfo as ZenModelInfo } from './catalog.ts'

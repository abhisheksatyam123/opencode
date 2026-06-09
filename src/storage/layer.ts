import { Layer } from "effect"
import { AppFileSystem } from "@/filesystem"
import { StorageAdapterLayer } from "@/storage/impl/adapter"

export { Storage } from "@/storage/contract/port"
export const StorageLayer = StorageAdapterLayer
export const StorageDefaultLayer = StorageAdapterLayer.pipe(Layer.provide(AppFileSystem.defaultLayer))

// Public API barrel for the GRBL serial transport layer.

export { GrblConnection } from './grblConnection'
export type { PortLike, GrblConnectionOptions } from './grblConnection'

export { Streamer, GRBL_RX_BUFFER, RX_BUFFER_LIMIT } from './streamer'
export type { StreamMode, StreamerOptions } from './streamer'

export {
  parseStatusReport,
  isStatusReport,
} from './status'
export type {
  StatusReport,
  GrblState,
  Overrides,
  Vec3,
} from './status'

export {
  RealtimeByte,
  REALTIME_BYTE_VALUES,
  isRealtimeByte,
} from './realtime'
export type { RealtimeByteName } from './realtime'

export {
  parseSettingLine,
  parseSettingsBlock,
  readSettingsCommand,
  writeSettingCommand,
  settingLabel,
  GRBL_SETTING_META,
} from './settings'
export type { GrblSetting, GrblSettingMeta } from './settings'

export { MockPort } from './mockPort'
export type { MockPortOptions } from './mockPort'

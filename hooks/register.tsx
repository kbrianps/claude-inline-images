import type { BuiltinToolResults, Register } from 'claude-code'

type TOutput = BuiltinToolResults['SendUserFile']
type TReadOutput = BuiltinToolResults['Read']
type TAttachment = TOutput['attachments'][number]
type TSize = { width: number; height: number }
type TPicture = { size: TSize | null; png: string | null }

const MAX_COLUMNS = 80
const MAX_ROWS = 30
const READ_MAX_COLUMNS = 40
const READ_MAX_ROWS = 15
const READ_PATHS_LIMIT = 200
const MARGIN = 4
const CELL_RATIO = 2
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_INLINE_BYTES = 2 * 1024 * 1024
const CACHE_LIMIT = 24
const FALLBACK_SIZE: TSize = { width: 1600, height: 1000 }

const pictures = new Map<string, TPicture>()
const readPaths = new Map<string, string>()

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const decodeBase64 = (text: string) => {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0

  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
}

const pngSize = (base64: string): TSize | null => {
  const header = decodeBase64(base64.slice(0, 44))
  const isSignature = header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
  if (!isSignature) return null

  const view = new DataView(header.buffer)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const isDrawable = (file: TAttachment) =>
  file.isImage &&
  file.path.startsWith('/') &&
  /\.png$/i.test(file.path) &&
  file.pathValidated !== false

const hasError = (file: TAttachment) => Boolean(file.upload_error || file.partial_error)

const cacheKey = (file: TAttachment) => `${file.path}:${file.size}`

const remember = (key: string, picture: TPicture) => {
  pictures.delete(key)
  pictures.set(key, picture)
  if (pictures.size > CACHE_LIMIT) {
    const oldest = pictures.keys().next().value
    if (oldest !== undefined) pictures.delete(oldest)
  }
}

const fileUrl = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`

const boxFor = ({ width, height }: TSize, maxColumns: number, maxRows = MAX_ROWS) => {
  let columns = Math.min(maxColumns, Math.max(1, Math.round(width / 10)))
  let rows = Math.max(1, Math.round((columns * height) / width / CELL_RATIO))

  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.round((rows * CELL_RATIO * width) / height))
  }

  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}

type TReadImage = { base64: string; size: TSize; path?: string }

const readImage = (output: unknown, path?: string): TReadImage | null => {
  const read = output as TReadOutput | undefined
  if (!read || read.type !== 'image' || read.file.type !== 'image/png') return null

  const { base64, dimensions } = read.file
  if ((base64.length * 3) / 4 > MAX_INLINE_BYTES) return null

  const width = dimensions?.originalWidth ?? dimensions?.displayWidth
  const height = dimensions?.originalHeight ?? dimensions?.displayHeight
  const size = width && height ? { width, height } : pngSize(base64)

  return size ? { base64, size, path } : null
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) return next(e)

    const images = e.props.calls.flatMap(call => {
      if (call.tool !== 'Read' || call.isRunning || call.isErrored || call.isInterrupted) return []
      const path = (call.input as { file_path?: string } | undefined)?.file_path
      const image = readImage(call.output, path)
      return image ? [image] : []
    })
    if (images.length === 0) return next(e)

    const line = await next(e)
    const viewportColumns = e.viewport?.columns ?? READ_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(READ_MAX_COLUMNS, viewportColumns - MARGIN))
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        {line}
        {images.map((image, index) => {
          const box = boxFor(image.size, maxColumns, READ_MAX_ROWS)
          const name = image.path?.split('/').pop() ?? 'image.png'

          return (
            <Box key={`${index}:${image.path ?? ''}`} flexDirection="column" gap={1} marginLeft={2}>
              <Image source={{ png: image.base64 }} columns={box.columns} rows={box.rows} alt={`[image] ${name}`} />
              {image.path ? (
                <Text dimColor>
                  <Link href={fileUrl(image.path)} label={image.path} />
                </Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('tool.call', { tool: 'Read' }, ($, e, next) => {
    readPaths.set(e.tool_use_id, e.file_path)
    if (readPaths.size > READ_PATHS_LIMIT) {
      const oldest = readPaths.keys().next().value
      if (oldest !== undefined) readPaths.delete(oldest)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== 'Read' || e.props.isErrored) {
      return next(e)
    }

    const image = readImage(e.props.output, readPaths.get(e.props.tool_use_id))
    if (!image) return next(e)

    const viewportColumns = e.viewport?.columns ?? READ_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(READ_MAX_COLUMNS, viewportColumns - MARGIN))
    const box = boxFor(image.size, maxColumns, READ_MAX_ROWS)
    const path = image.path
    const name = path?.split('/').pop() ?? 'image.png'
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1} marginBottom={1}>
        <Image source={{ png: image.base64 }} columns={box.columns} rows={box.rows} alt={`[image] ${name}`} />
        {path ? (
          <Text dimColor>
            <Link href={fileUrl(path)} label={path} />
          </Text>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== 'SendUserFile' || e.props.isErrored) {
      return next(e)
    }

    const output = e.props.output as TOutput | undefined
    const attachments = output?.attachments ?? []
    if (!output || output.display === 'attach' || attachments.some(hasError)) return next(e)

    const images = attachments.filter(isDrawable)
    if (images.length === 0) return next(e)

    for (const image of images) {
      const key = cacheKey(image)
      if (pictures.has(key)) continue

      const original = image.scaled
        ? { width: image.scaled.original_width, height: image.scaled.original_height }
        : null

      if (image.size > MAX_READ_BYTES) {
        remember(key, { size: original, png: null })
        continue
      }

      try {
        const { base64 } = await $.fs.read(image.path, { as: 'bytes' })
        const size = pngSize(base64)
        const png = size && image.size <= MAX_INLINE_BYTES ? base64 : null
        remember(key, { size: size ?? original, png })
      } catch {
        remember(key, { size: original, png: null })
      }
    }

    const viewportColumns = e.viewport?.columns ?? MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(MAX_COLUMNS, viewportColumns - MARGIN))
    const others = attachments.filter(file => !images.includes(file))
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1} marginTop={1} marginBottom={1}>
        {output.caption ? <Text dimColor>{output.caption}</Text> : null}
        {images.map(image => {
          const picture = pictures.get(cacheKey(image))
          const box = boxFor(picture?.size ?? FALLBACK_SIZE, maxColumns)
          const name = image.path.split('/').pop() ?? image.path

          return (
            <Box key={image.path} flexDirection="column" gap={1}>
              <Image
                source={
                  picture?.png
                    ? { png: picture.png }
                    : { file: image.path, format: 'png', generation: image.size }
                }
                columns={box.columns}
                rows={box.rows}
                alt={`[image] ${name}`}
              />
              <Text dimColor>
                <Link href={fileUrl(image.path)} label={image.path} />
              </Text>
            </Box>
          )
        })}
        {others.map(file => (
          <Text key={file.path} dimColor>
            {file.path}
          </Text>
        ))}
      </Box>
    )
  })
}

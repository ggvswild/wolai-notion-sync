import { extname } from "node:path";
import { digest } from "./sync-safety.mjs";
import { storedZip } from "./archive-fallback.mjs";

// https://developers.notion.com/guides/data-apis/working-with-files-and-media
// A generic download Content-Type is not a valid Notion upload MIME type.
const MIME_GROUPS = [
  ["image/png", "png"], ["image/apng", "apng"], ["image/jpeg", "jpg jpeg"],
  ["image/gif", "gif"], ["image/heic", "heic"], ["image/svg+xml", "svg"],
  ["image/tiff", "tif tiff"], ["image/webp", "webp"], ["image/avif", "avif"],
  ["image/bmp", "bmp"], ["image/vnd.microsoft.icon", "ico"],
  ["application/pdf", "pdf"], ["text/plain", "txt"], ["text/markdown", "md markdown"],
  ["text/csv", "csv"], ["text/tab-separated-values", "tsv"], ["application/json", "json"],
  ["application/javascript", "js"], ["application/typescript", "ts"], ["text/x-python", "py"],
  ["text/html", "html htm"], ["text/xml", "xml"], ["text/css", "css"],
  ["text/yaml", "yaml yml"], ["text/calendar", "ics"], ["application/rtf", "rtf"],
  ["application/msword", "doc dot"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.template", "dotx"],
  ["application/vnd.ms-excel", "xls xlt xla"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.template", "xltx"],
  ["application/vnd.ms-powerpoint", "ppt pot pps ppa"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.template", "potx"],
  ["application/vnd.oasis.opendocument.text", "odt"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  ["application/epub+zip", "epub"], ["application/zip", "zip"],
  ["application/gzip", "gz gzip"], ["application/x-tar", "tar"],
  ["application/x-7z-compressed", "7z"], ["application/x-bzip2", "bz2"], ["application/vnd.rar", "rar"],
  ["audio/aac", "aac adts"], ["audio/midi", "mid midi"], ["audio/mpeg", "mp3 mpga"],
  ["audio/mp4", "m4a m4b"], ["audio/ogg", "oga ogg opus"], ["audio/wav", "wav"],
  ["audio/x-ms-wma", "wma"], ["audio/webm", "weba"], ["audio/x-flac", "flac"],
  ["video/x-amv", "amv"], ["video/x-ms-asf", "asf wmv"], ["video/x-msvideo", "avi"],
  ["video/x-f4v", "f4v"], ["video/x-flv", "flv"], ["video/mp4", "mp4 m4v gifv"],
  ["video/webm", "webm"], ["video/quicktime", "mov qt"], ["video/mpeg", "mpeg"],
  ["video/ogg", "ogv"], ["video/3gpp", "3gp"], ["video/3gpp2", "3g2"],
];
const MIME_BY_EXTENSION = new Map(MIME_GROUPS.flatMap(([mime, suffixes]) => suffixes.split(" ").map(suffix => [`.${suffix}`, mime])));
const EXTENSION_BY_MIME = new Map(MIME_GROUPS.map(([mime, suffixes]) => [mime, `.${suffixes.split(" ")[0]}`]));
const SUPPORTED_EXTENSIONS = new Set([...MIME_BY_EXTENSION.keys(), ".mkv"]);

export function mediaUploadPayload(bytes, name, responseType, blockType) {
  let contentType = String(responseType ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  let filename = name;
  let extension = extname(filename).toLowerCase();
  if (!extension && EXTENSION_BY_MIME.has(contentType)) {
    filename += EXTENSION_BY_MIME.get(contentType);
    extension = extname(filename).toLowerCase();
  }
  if (blockType === "file" && !SUPPORTED_EXTENSIONS.has(extension)) {
    return {
      bytes: storedZip([{ name: filename, bytes }]), filename: `${filename}.zip`, contentType: "application/zip",
      archive: { format: "zip", reason: "unsupported-file-extension", filename, bytes: bytes.length, sha256: digest(bytes) },
    };
  }
  if (["application/octet-stream", "binary/octet-stream", "application/binary", ""].includes(contentType)) {
    contentType = MIME_BY_EXTENSION.get(extension);
  }
  if (!contentType) throw new Error("无法准确识别媒体 MIME 类型，保留原件等待处理");
  return { bytes, filename, contentType };
}

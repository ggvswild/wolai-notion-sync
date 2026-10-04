# Dependencies and provenance

## Runtime

- **Node.js**: JavaScript runtime and built-in filesystem, test runner, crypto and buffer APIs. Installed by the user; not bundled with this project. See https://nodejs.org/.
- **Undici 7.30.0**: HTTP client, proxy support, and multipart form handling. MIT license; https://github.com/nodejs/undici. Exact package integrity and public registry URL are recorded in `package-lock.json`. Its license remains included in the installed dependency.
- ZIP storage/CRC32 and synchronization/rendering logic are project source code; there are no bundled proprietary binaries, copied credentials, SDK account stores, or private export archives.

## External services

Wolai MCP and the Notion API are external services, not code dependencies redistributed here. Users supply their own authorized credentials and remain subject to each service's terms, access controls and API limits. Product names are used descriptively; there is no endorsement or affiliation.

## Origin

This community edition extracts reusable synchronization algorithms from a local personal workflow. Private configuration, account identifiers, caches, notes, logs, migration scripts, audit reports and machine-specific launchers are intentionally excluded. Tests are synthetic. No production data is an open-source fixture.

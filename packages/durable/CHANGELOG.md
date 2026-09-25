# Changelog

## [Unreleased]

### Breaking Changes

- Reordered Storage scan arguments so the limit precedes the cursor.
- Added the required conversation-visible `Storage.entry(conversationId, id, context)` overload.

### Added

- Added transactional Sessions with typed durable documents, task creation, snapshots, retirement, and commit publications.
- Added document checkpoint selection, lazy version migration, and `Session.snapshotAsOf()` for rewindable conversation documents.

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

### Added

- Added the initial Pico durable record contracts and detached in-memory storage implementation.

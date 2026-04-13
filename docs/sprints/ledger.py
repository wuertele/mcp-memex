#!/usr/bin/env python3
"""
Sprint ledger CLI, backed by docs/sprints/ledger.tsv.

Tracks sprint status through the lifecycle:
  planned -> in_progress -> completed (or skipped)

This is the **source of truth** for which sprint we are on and
what is coming next. It ties the structured ledger in
docs/sprints/ledger.tsv to the narrative specs in
docs/sprints/SPRINT-*.md.

Common usage from the repo root:
  python3 docs/sprints/ledger.py stats      # overview of all sprints
  python3 docs/sprints/ledger.py current    # what is in_progress right now
  python3 docs/sprints/ledger.py next       # the next planned sprint
  python3 docs/sprints/ledger.py add 017 "New Sprint Title"
  python3 docs/sprints/ledger.py start 017  # mark that sprint as in_progress
  python3 docs/sprints/ledger.py complete 017
"""

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List


class SprintEntry:
    """Represents a single sprint ledger entry."""

    VALID_STATUSES = ["planned", "in_progress", "completed", "skipped"]

    def __init__(self, sprint_id: str, title: str, status: str, created_at: str, updated_at: str):
        self.sprint_id = sprint_id
        self.title = title
        self.status = status
        self.created_at = created_at
        self.updated_at = updated_at

    @property
    def sprint_number(self) -> int:
        """Parse sprint number for sorting (e.g., '015' -> 15)."""
        return int(self.sprint_id)

    @property
    def doc_path(self) -> str:
        """Path to the sprint document."""
        return f"docs/sprints/SPRINT-{self.sprint_id}.md"

    def to_tsv(self) -> str:
        """Convert to TSV format."""
        return f"{self.sprint_id}\t{self.title}\t{self.status}\t{self.created_at}\t{self.updated_at}"

    @classmethod
    def from_tsv(cls, line: str) -> 'SprintEntry':
        """Parse from TSV line."""
        parts = line.strip().split('\t')
        if len(parts) != 5:
            raise ValueError(f"Invalid TSV line (expected 5 fields): {line}")
        return cls(parts[0], parts[1], parts[2], parts[3], parts[4])

    def __repr__(self):
        return f"SprintEntry({self.sprint_id}, {self.title}, {self.status})"


class SprintLedger:
    """Manages the sprint ledger."""

    HEADER = "sprint_id\ttitle\tstatus\tcreated_at\tupdated_at"

    def __init__(self, path: Path = None):
        self.path = path or Path(__file__).parent / "ledger.tsv"
        self.entries: List[SprintEntry] = []

    def load(self) -> 'SprintLedger':
        """Load ledger from file."""
        if not self.path.exists():
            return self

        with open(self.path) as f:
            lines = [line.strip() for line in f if line.strip()]

        if not lines:
            return self

        # Skip header
        if lines[0] == self.HEADER:
            lines = lines[1:]

        self.entries = [SprintEntry.from_tsv(line) for line in lines]
        return self

    def save(self):
        """Save ledger to file, sorted by sprint number."""
        # Sort by sprint number
        self.entries.sort(key=lambda e: e.sprint_number)

        with open(self.path, 'w') as f:
            f.write(self.HEADER + '\n')
            for entry in self.entries:
                f.write(entry.to_tsv() + '\n')

    def _now_iso(self) -> str:
        """Get current timestamp in ISO8601 format."""
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def add(self, sprint_id: str, title: str, status: str = "planned") -> bool:
        """
        Add a new sprint to the ledger.
        Returns True if added, False if already exists.
        """
        # Normalize sprint_id to 3 digits
        sprint_id = sprint_id.zfill(3)

        # Check if already exists
        if any(e.sprint_id == sprint_id for e in self.entries):
            return False

        now = self._now_iso()
        self.entries.append(SprintEntry(sprint_id, title, status, now, now))
        return True

    def update_status(self, sprint_id: str, status: str) -> bool:
        """
        Update the status of an existing sprint.
        Returns True if updated, False if not found.
        """
        sprint_id = sprint_id.zfill(3)

        if status not in SprintEntry.VALID_STATUSES:
            raise ValueError(f"Invalid status: {status}. Must be one of: {SprintEntry.VALID_STATUSES}")

        for entry in self.entries:
            if entry.sprint_id == sprint_id:
                entry.status = status
                entry.updated_at = self._now_iso()
                return True
        return False

    def get_next_planned(self) -> SprintEntry | None:
        """Get the lowest-numbered sprint with status='planned'."""
        planned = [e for e in self.entries if e.status == "planned"]
        if not planned:
            return None
        return min(planned, key=lambda e: e.sprint_number)

    def get_in_progress(self) -> SprintEntry | None:
        """Get the sprint currently in progress (should be at most one)."""
        in_progress = [e for e in self.entries if e.status == "in_progress"]
        if not in_progress:
            return None
        return in_progress[0]

    def get_by_id(self, sprint_id: str) -> SprintEntry | None:
        """Get entry by sprint ID."""
        sprint_id = sprint_id.zfill(3)
        for entry in self.entries:
            if entry.sprint_id == sprint_id:
                return entry
        return None

    def get_by_status(self, status: str) -> List[SprintEntry]:
        """Get all entries with given status."""
        return [e for e in self.entries if e.status == status]

    def count_by_status(self) -> dict:
        """Count entries by status."""
        counts = {s: 0 for s in SprintEntry.VALID_STATUSES}
        for entry in self.entries:
            if entry.status in counts:
                counts[entry.status] += 1
        return counts

    def sync_from_docs(self) -> tuple[int, int]:
        """
        Sync ledger with sprint docs alongside the ledger (docs/sprints/*.md).
        Returns (added_count, total_count).
        """
        # The canonical location is docs/sprints/, so by default we look for
        # SPRINT-*.md files in the same directory as the ledger TSV.
        docs_dir = self.path.parent
        if not docs_dir.exists():
            return 0, len(self.entries)

        added = 0
        for doc in sorted(docs_dir.glob("SPRINT-*.md")):
            # Extract sprint ID from filename
            sprint_id = doc.stem.replace("SPRINT-", "")

            # Try to extract title from first heading
            title = f"Sprint {sprint_id}"
            try:
                with open(doc) as f:
                    for line in f:
                        if line.startswith("# Sprint"):
                            # "# Sprint 015: Title Here" -> "Title Here"
                            parts = line.split(":", 1)
                            if len(parts) > 1:
                                title = parts[1].strip()
                            break
            except Exception:
                pass

            if self.add(sprint_id, title):
                added += 1

        return added, len(self.entries)


def main():
    """CLI interface."""
    import argparse

    parser = argparse.ArgumentParser(description="Manage sprint ledger")
    parser.add_argument('--ledger', type=Path, help="Path to ledger.tsv")

    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # add command
    add_parser = subparsers.add_parser('add', help='Add a new sprint')
    add_parser.add_argument('sprint_id', help='Sprint ID (e.g., 015)')
    add_parser.add_argument('title', help='Sprint title')
    add_parser.add_argument('--status', default='planned',
                           choices=SprintEntry.VALID_STATUSES)

    # start command
    start_parser = subparsers.add_parser('start', help='Mark sprint as in_progress')
    start_parser.add_argument('sprint_id', help='Sprint ID')

    # complete command
    complete_parser = subparsers.add_parser('complete', help='Mark sprint as completed')
    complete_parser.add_argument('sprint_id', help='Sprint ID')

    # skip command
    skip_parser = subparsers.add_parser('skip', help='Mark sprint as skipped')
    skip_parser.add_argument('sprint_id', help='Sprint ID')

    # status command
    status_parser = subparsers.add_parser('status', help='Update sprint status')
    status_parser.add_argument('sprint_id', help='Sprint ID')
    status_parser.add_argument('new_status', choices=SprintEntry.VALID_STATUSES)

    # next command
    subparsers.add_parser('next', help='Get next planned sprint')

    # current command
    subparsers.add_parser('current', help='Get current in-progress sprint')

    # stats command
    subparsers.add_parser('stats', help='Show ledger statistics')

    # list command
    list_parser = subparsers.add_parser('list', help='List sprints')
    list_parser.add_argument('--status', choices=SprintEntry.VALID_STATUSES,
                            help='Filter by status')

    # sync command
    subparsers.add_parser('sync', help='Sync ledger from docs/sprints/*.md files')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    ledger = SprintLedger(args.ledger).load()

    if args.command == 'add':
        if ledger.add(args.sprint_id, args.title, args.status):
            ledger.save()
            print(f"Added sprint {args.sprint_id}: {args.title} [{args.status}]")
        else:
            print(f"Sprint {args.sprint_id} already exists", file=sys.stderr)
            return 1

    elif args.command == 'start':
        # Check if another sprint is in progress
        current = ledger.get_in_progress()
        if current and current.sprint_id != args.sprint_id.zfill(3):
            print(f"Warning: Sprint {current.sprint_id} is already in progress", file=sys.stderr)

        if ledger.update_status(args.sprint_id, "in_progress"):
            ledger.save()
            print(f"Sprint {args.sprint_id} is now in_progress")
        else:
            print(f"Sprint {args.sprint_id} not found", file=sys.stderr)
            return 1

    elif args.command == 'complete':
        if ledger.update_status(args.sprint_id, "completed"):
            ledger.save()
            print(f"Sprint {args.sprint_id} marked as completed")
        else:
            print(f"Sprint {args.sprint_id} not found", file=sys.stderr)
            return 1

    elif args.command == 'skip':
        if ledger.update_status(args.sprint_id, "skipped"):
            ledger.save()
            print(f"Sprint {args.sprint_id} marked as skipped")
        else:
            print(f"Sprint {args.sprint_id} not found", file=sys.stderr)
            return 1

    elif args.command == 'status':
        if ledger.update_status(args.sprint_id, args.new_status):
            ledger.save()
            print(f"Sprint {args.sprint_id} status updated to '{args.new_status}'")
        else:
            print(f"Sprint {args.sprint_id} not found", file=sys.stderr)
            return 1

    elif args.command == 'next':
        entry = ledger.get_next_planned()
        if entry:
            print(f"{entry.sprint_id}\t{entry.title}")
            print(f"  Doc: {entry.doc_path}")
        else:
            print("No planned sprints", file=sys.stderr)
            return 1

    elif args.command == 'current':
        entry = ledger.get_in_progress()
        if entry:
            print(f"{entry.sprint_id}\t{entry.title}")
            print(f"  Doc: {entry.doc_path}")
            print(f"  Started: {entry.updated_at}")
        else:
            print("No sprint currently in progress", file=sys.stderr)
            return 1

    elif args.command == 'stats':
        counts = ledger.count_by_status()
        total = len(ledger.entries)
        print(f"Total sprints: {total}")
        print(f"  planned:     {counts['planned']}")
        print(f"  in_progress: {counts['in_progress']}")
        print(f"  completed:   {counts['completed']}")
        print(f"  skipped:     {counts['skipped']}")

        current = ledger.get_in_progress()
        if current:
            print(f"\nCurrently working on: Sprint {current.sprint_id} - {current.title}")

        next_up = ledger.get_next_planned()
        if next_up:
            print(f"Next up: Sprint {next_up.sprint_id} - {next_up.title}")

    elif args.command == 'list':
        entries = ledger.entries
        if args.status:
            entries = ledger.get_by_status(args.status)

        if not entries:
            print("No sprints found")
            return 0

        for entry in entries:
            status_marker = {
                "planned": "[ ]",
                "in_progress": "[>]",
                "completed": "[x]",
                "skipped": "[-]",
            }.get(entry.status, "[?]")
            print(f"{status_marker} {entry.sprint_id}: {entry.title}")

    elif args.command == 'sync':
        added, total = ledger.sync_from_docs()
        ledger.save()
        print(f"Synced: {added} new sprints added, {total} total in ledger")

    return 0


if __name__ == '__main__':
    sys.exit(main())

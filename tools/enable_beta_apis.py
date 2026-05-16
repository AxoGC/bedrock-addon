"""Enable Beta APIs experiment in a Bedrock world's level.dat.

Bedrock level.dat layout:
  bytes 0..3   uint32 LE  version
  bytes 4..7   uint32 LE  payload length
  bytes 8..    uncompressed little-endian NBT (root TAG_Compound)

We add (or set) the `experiments` compound with `gametest=1` and
`experiments_ever_used=1`, which is what the in-game UI does when you
toggle "Beta APIs".
"""
from __future__ import annotations
import io
import struct
import sys
from pathlib import Path
from nbtlib import File, Compound, Byte


def patch(level_dat: Path) -> None:
    raw = level_dat.read_bytes()
    if len(raw) < 8:
        raise SystemExit(f"file too small: {level_dat}")
    version = struct.unpack("<I", raw[0:4])[0]
    declared_len = struct.unpack("<I", raw[4:8])[0]
    payload = raw[8:]
    if len(payload) < declared_len:
        raise SystemExit(
            f"truncated: header says {declared_len}, payload is {len(payload)}"
        )

    nbt = File.parse(io.BytesIO(payload[:declared_len]), byteorder="little")

    exps = nbt.get("experiments")
    if not isinstance(exps, Compound):
        exps = Compound()
        nbt["experiments"] = exps

    changed = []
    if exps.get("gametest") != Byte(1):
        exps["gametest"] = Byte(1)
        changed.append("gametest=1")
    if exps.get("experiments_ever_used") != Byte(1):
        exps["experiments_ever_used"] = Byte(1)
        changed.append("experiments_ever_used=1")
    if nbt.get("saved_with_toggled_experiments") != Byte(1):
        nbt["saved_with_toggled_experiments"] = Byte(1)
        changed.append("saved_with_toggled_experiments=1")

    buf = io.BytesIO()
    nbt.write(buf, byteorder="little")
    new_payload = buf.getvalue()

    out = bytearray()
    out += struct.pack("<I", version)
    out += struct.pack("<I", len(new_payload))
    out += new_payload

    backup = level_dat.with_suffix(level_dat.suffix + ".bak")
    if not backup.exists():
        backup.write_bytes(raw)
        print(f"backup -> {backup}")

    level_dat.write_bytes(bytes(out))
    if changed:
        print("patched:", ", ".join(changed))
    else:
        print("already enabled, no change")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: enable_beta_apis.py <path/to/level.dat>")
    patch(Path(sys.argv[1]))

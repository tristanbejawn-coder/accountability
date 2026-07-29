# Drop zone — Thaipusam, Batu Caves source frames

Upload the shoot's JPEGs into this folder (6–10 frames is plenty; the
1080px-wide portfolio exports are fine).

**Naming:**

- Rename the hero frame — *the man lying on the floor* — so its filename
  contains `hero` anywhere (e.g. `hero_floor.jpg`). Prep picks it up
  automatically; everything else can keep its camera filename.
- The first six files in sort order become the round-1 selects.

**Fastest way to upload:** on GitHub, branch
`claude/reel-assembly-pipeline-evqjck`, open this folder and use
*Add file → Upload files* (drag and drop), or go straight to:

    https://github.com/tristanbejawn-coder/accountability/upload/claude/reel-assembly-pipeline-evqjck/assets/source/thaipusam

Then the reel rebuilds with:

```bash
rm -f assets/thaipusam-batu-caves/contact_push_standin.mp4 \
      assets/thaipusam-batu-caves/living_standin.mp4
python3 reelkit/prep.py --series "Thaipusam — Batu Caves" \
    --stills assets/source/thaipusam --force
python3 reelkit/assemble.py
```

(The `rm` forces the two stand-in clips to regenerate from the real
contact sheet and hero instead of the test plates.)

#!/usr/bin/env python3
"""Each hoverboard assertion gets a targeted revert: break exactly the line it claims to
protect, rebuild, run the smoke suite, and confirm THAT check goes red. Usage (from the repo
root):  python3 tools/revert-hoverboard.py"""
import subprocess, os, sys, shutil
sys.stdout.reconfigure(line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HB, MN = 'src/trails/hoverboard.js', 'src/trails/main.js'
FILES = [HB, MN, 'src/trails/gait.js', 'src/trails/dog-driver.js']
BACKUP = {f: open(os.path.join(ROOT, f)).read() for f in FILES}
for f in FILES: shutil.copy(os.path.join(ROOT, f), '/tmp/pristine_' + os.path.basename(f))   # a killed run leaves a mutated source; this is the way back
REVERTS = [
  ("a stopped board is no longer a parking brake: it creeps and moves with no kick", HB,
   "else a = net > roll ? net - roll : 0;", "else a = net;", "a board at rest on a gentle slope stays put"),
  ("gravity is boosted like Neon's", HB, "gravityGain: 1.0,", "gravityGain: 1.8,", "gravity pulls it down a descent at the real rate"),
  ("no drag off the tread", HB, "const roll = HB.roll + HB.offRoll*off + (o.brake ? HB.brake : 0);",
   "const roll = HB.roll + (o.brake ? HB.brake : 0);", "off the tread it slows"),
  ("brake does nothing", HB, "(o.brake ? HB.brake : 0)", "0", "pulling back drags a foot"),
  ("the kick ignores the legs' ceiling", HB, "const taper = clamp(1 - v/Math.max(0.1, o.kickTop || 6), 0, 1);",
   "const taper = 1;", "holding sprint kicks it up to speed"),
  ("a hop counts as off the trail", MN, "b.off += (((hop || onTread) ? 0 : 1) - b.off)", "b.off += ((onTread ? 0 : 1) - b.off)",
   "a hop over the same ground is floating"),
  ("steering works in the air", MN, "if(!hop && mag > 0.03){", "if(mag > 0.03){", "a hop keeps its heading and speed"),
  ("any step up is climbable", MN, "if(rise > lim*HB.stepTol) return 'blocked';", "if(rise > lim) return 'blocked';",
   "any step up stops it dead"),
  ("a drop never throws the rider", MN, "if(rise < -lim) return 'cliff';", "if(rise < -lim*1000) return 'cliff';",
   "going over a drop without jumping throws the rider"),
  ("stopped jump hops instead of exiting", MN, "if(hbs.v < HB.stopV){ exitBoard(); return; }", "", "stopped, jump hops off to the side"),
  ("the board does not follow below a hop", MN, "hbs.alt = Math.min(hbs.alt, g + player.y);", "hbs.alt = g + HB.deckY + 5;",
   "the board follows below the pup"),
  ("races allow boards", MN, "if(hbs.riding || hbs.carried || !hbs.placed || race.on || hbs.mountBlockT > 0) return false;",
   "if(hbs.riding || hbs.carried || !hbs.placed || hbs.mountBlockT > 0) return false;", "no board in a race"),
  # ---- round two ----
  ("the camera chases the stick again, not the board's heading", MN, "if(rideNow && player.speed > 0.4 && performance.now()-lastLookT > 900){",
   "if(false){", "the camera stays behind the board through a carve"),
  ("a look drag is overridden by the board follow", MN, "performance.now()-lastLookT > 900){\n    const want", "true){\n    const want",
   "a hand on the camera is left alone"),
  ("crouching adds no drag benefit", HB, "HB.dragK*(o.crouch ? HB.crouchDrag : 1)*", "HB.dragK*", "crouching tucks the rider in"),
  ("a crouched pup can still kick", MN, " && !b.braking && !crouch;", " && !b.braking;", "a tucked pup cannot kick"),
  ("the kick runs the legs instead of pushing with one", "src/trails/gait.js", "  if(legCount) legs[lead] = ang;", "  if(legCount) legs[lead] = 0;",
   "the kick is one hind paw pushing"),
  ("the pushing leg never stretches to the ground", "src/trails/dog-driver.js", "sy = 1 + (clamp(need, 1, 1.8) - 1)*kp.plant*kickAmt*(1 - leapAmt);", "sy = 1;",
   "through the real rig, kicking swings and lengthens one leg"),
  ("bark never picks the board up", MN, "  if(bd < Infinity){ pickUpBoard(); return true; }", "", "bark beside the board slings it on your back"),
  ("a carried board can still be landed on", MN, "if(hbs.riding || hbs.carried || !hbs.placed || race.on", "if(hbs.riding || !hbs.placed || race.on",
   "a carried board rides on the back"),
  ("jump picks the board up again", MN, "  if(hbs.riding){ rideJump(); return; }      // hop, or hop OFF when stopped\n",
   "  if(hbs.riding){ rideJump(); return; }\n  if(boardReachDist() < Infinity){ pickUpBoard(); return; }\n", "jump does not pick it up"),
  ("an animal on the back no longer blocks the board", MN, "  if(getCarried()){ releaseCarried(player.x, player.z, player.yaw); return true; }\n", "",
   "with the board and an animal both in reach"),
  ("the board is one fixed size", HB, "  const len = clamp(Math.max(torso*1.7, wide*1.6), 0.7, 7);", "  const len = 1.7;", "the board is sized to the animal"),
  ("the board keeps its original colours", HB, "  hbs.pal = hbPalette(k.color);", "  hbs.pal = hbPalette(0x808080);", "the board's colours are the complement"),
  ("auto-walk allowed while riding", MN, "if(hbs.riding){ refuseAutoBtn(); return false; }", "", "riding, auto-walk is refused"),
  ("new walk does not re-seed the board", MN, "hbDismount(); seedBoard();         // a walk starts here", "hbDismount();",
   "a new walk puts it back near the start"),
]
def restore():
    for f, t in BACKUP.items(): open(os.path.join(ROOT, f), 'w').write(t)
def smoke():
    subprocess.run(['python3', 'build.py'], cwd=ROOT, capture_output=True)
    return subprocess.run(['node', 'tools/smoke.js'], cwd=ROOT, capture_output=True, text=True).stdout
ONLY = sys.argv[1:]            # optional substrings of a check name: run just those reverts
for label, f, find, repl, check in REVERTS:
    find = find.replace('\\n', chr(10))
    if BACKUP[f].count(find) != 1: print('!! anchor missing/ambiguous:', label)
bad = 0
try:
    for label, f, find, repl, check in REVERTS:
        if ONLY and not any(o in check or o in label for o in ONLY): continue
        find = find.replace('\\n', chr(10)); repl = repl.replace('\\n', chr(10))
        src = BACKUP[f]
        if src.count(find) != 1: print('!! anchor missing/ambiguous:', label); bad += 1; continue
        open(os.path.join(ROOT, f), 'w').write(src.replace(find, repl))
        out = smoke()
        red = any(l.lstrip().startswith('FAIL') and check in l for l in out.splitlines())
        print(('ok   ' if red else 'LIVE ') + label + '  ->  "' + check + '"')
        bad += (not red); restore()
finally:
    restore(); subprocess.run(['python3', 'build.py'], cwd=ROOT, capture_output=True)
print('\n%d revert(s) did NOT turn their check red' % bad)

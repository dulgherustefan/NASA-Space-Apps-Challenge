import os, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from planner import *
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
L = load_core(R)
z, sm, sand, rough, beta, sky = L["z"], L["slope_mean"], L["sand"], L["rough"], L["beta"], L["sky"]
s10 = slope10(z)
print("slope_mean median %.1f  slope10 median %.1f | walkable s10<=20: %.1f%%  s10<=25: %.1f%%" % (np.median(sm), np.median(s10), 100 * (s10 <= 20).mean(), 100 * (s10 <= 25).mean()))
rc = lambda e, s: (int(s / 5), int(e / 5))
A, C = (2598, 1858), (2342, 2072)
b0 = blocked_mask(L); b1 = blocked_mask(L, 27.8)
fields = {}
for name, pt in dict(A=A, C=C).items():
    i, j = rc(*pt); fields[name] = cost_to_go(z, s10, sand, rough, b0, i, j, 0.5, 1e9)
def tt(name, e, s):
    T, nxt = fields[name]; i, j = rc(e, s)
    t, Ln, _ = trace(nxt, T, z, sand, rough, i, j); return t / 60, Ln
print("A->C: %.1f min %.0f m ; C->A %.1f min" % (*tt("C", *A), tt("A", *C)[0]))
# candidate science sites: grid near A
print("candidate S (e,s): tA[min] lenA  tC[min]  slope10 beta sand")
for e in range(2000, 3301, 100):
    for s in range(900, 1900, 100):
        i, j = rc(e, s)
        if b0[i, j]: continue
        ta, la = tt("A", e, s); tc, lc = tt("C", e, s)
        if ta < 0 or not (10 <= ta <= 24): continue
        print("  (%d,%d): %5.1f %5.0f  %5.1f   %4.1f %4.1f %.2f" % (e, s, ta, la, tc, s10[i, j], beta[i, j], sand[i, j]))
np.save(os.path.join(R, "data_raw", "s10.npy"), s10)

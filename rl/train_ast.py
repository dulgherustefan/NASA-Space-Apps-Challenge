"""PPO adversary for Adaptive Stress Testing (Lee et al., JAIR 2020) on the walk simulator.

One adversary per (route, seed). All of them train in one batch on the GPU: G independent actor and critic
networks (stacked weights), G * envs walkers. Reward per step = log-likelihood of the disturbances chosen at
that step under their nominal distributions; +R_E when the walk fails, -100 * miss distance when it does not
(Lee et al. Eq. 6, gamma = 1). The stumble and injury draws are tilts of the simulator's own probabilities,
q = sigmoid(logit(p) + delta(s)); delta starts at 0, so the untrained adversary is plain Monte Carlo.

  python rl/train_ast.py --scenario S1 --seeds 0 1 2 --updates 150
  python rl/train_ast.py --scenario S1 --penalty ...       falls are a time-and-energy penalty, not terminal

Writes rl/runs/ast/ppo_<scenario>_<config>.json (+ .npz failure points, ckpt_*.pt weights).
"""
import argparse
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import ast_env as A
from ast_env import ASTEnv, Case, CLASSES, RUNS
from ast_cem import unpack_record, distinct, cfg_name

N_ACT = 5            # z_eff, z_cool, z_nav_x, z_nav_y (first step only), z_v (every step)
LOG2PI = math.log(2 * math.pi)


class GMLP(nn.Module):
    """G independent MLPs evaluated together: x [G, B, in] -> [G, B, out]."""

    def __init__(self, G, sizes, gains, seeds):
        super().__init__()
        self.W = nn.ParameterList(); self.b = nn.ParameterList()
        for i in range(len(sizes) - 1):
            w = torch.empty(G, sizes[i], sizes[i + 1])
            for g in range(G):
                gen = torch.Generator(); gen.manual_seed(1000 * seeds[g] + 17 * i + 3)
                t = torch.empty(sizes[i + 1], sizes[i])
                nn.init.orthogonal_(t, gain=gains[i], generator=gen)
                w[g] = t.t()
            self.W.append(nn.Parameter(w)); self.b.append(nn.Parameter(torch.zeros(G, 1, sizes[i + 1])))

    def forward(self, x):
        for i, (w, b) in enumerate(zip(self.W, self.b)):
            x = torch.baddbmm(b, x, w)
            if i < len(self.W) - 1:
                x = torch.tanh(x)
        return x


class Adversary(nn.Module):
    def __init__(self, G, n_obs, seeds):
        super().__init__()
        s2 = math.sqrt(2)
        self.actor = GMLP(G, [n_obs, 128, 128, N_ACT + 2], [s2, s2, 0.01], seeds)
        self.critic = GMLP(G, [n_obs, 256, 256, 1], [s2, s2, 1.0], [s + 500 for s in seeds])
        ls = torch.zeros(G, 1, N_ACT)          # episode channels start at their nominal spread (std 1), pace drift at exp(-0.5)
        ls[..., 4] = -0.5
        self.logstd = nn.Parameter(ls)
        self.register_buffer("mean", torch.zeros(G, 1, n_obs)); self.register_buffer("var", torch.ones(G, 1, n_obs))
        self.register_buffer("count", torch.tensor(1e-4))

    def update_norm(self, x):
        b = x.shape[1]
        m = x.mean(1, keepdim=True); v = x.var(1, keepdim=True, unbiased=False)
        tot = self.count + b
        d = m - self.mean
        self.var.copy_((self.var * self.count + v * b + d * d * self.count * b / tot) / tot)
        self.mean.copy_(self.mean + d * b / tot)
        self.count.copy_(tot)

    def norm(self, x):
        return ((x - self.mean) / torch.sqrt(self.var + 1e-8)).clamp(-10, 10)

    def act(self, x):
        out = self.actor(self.norm(x))
        return out[..., :N_ACT], out[..., N_ACT:].clamp(-20, 20)

    def value(self, x):
        return self.critic(self.norm(x)).squeeze(-1)


def policy_logp(mean, logstd, tilt, z, first, can, fell, inj, lpF, lpI, terminal):
    """Log-probability of what the adversary did: Gaussian dims in use + the tilted stumble / injury draws."""
    g = -0.5 * ((z - mean) / logstd.exp()) ** 2 - logstd - 0.5 * LOG2PI
    use = torch.ones_like(g)
    use[..., :4] = first[..., None].to(g.dtype)
    lp = (g * use).sum(-1)
    lf = lpF + tilt[..., 0]
    lp = lp + torch.where(can, torch.where(fell, F.logsigmoid(lf), F.logsigmoid(-lf)), torch.zeros_like(lf))
    if terminal:
        li = lpI + tilt[..., 1]
        lp = lp + torch.where(fell, torch.where(inj, F.logsigmoid(li), F.logsigmoid(-li)), torch.zeros_like(li))
    ent = (logstd + 0.5 * (1 + LOG2PI)).sum(-1).expand_as(lp)
    return lp, ent


def evaluate_policy(case, net, groups, falls_terminal, sig_scale, n_eval, seed):
    """Fresh-seed rollouts of every adversary: half with the mean action, half sampled. Recorded for replay."""
    dev = case.device
    G = len(groups)
    n = G * n_eval
    env = ASTEnv(case, n, seed=seed, falls_terminal=falls_terminal, sig_scale=sig_scale, mode="adv", record=True)
    rid = torch.tensor([r for r, _ in groups], device=dev).repeat_interleave(n_eval)
    env.reset_routes(rid)
    gen = torch.Generator(device=dev); gen.manual_seed(seed + 99)
    sample = (torch.arange(n_eval, device=dev) >= n_eval // 2)[None, :].expand(G, n_eval)
    k = 0
    with torch.no_grad():
        while not bool(env.done.all()) and k < 2200:
            o = env.observe()
            x = env.adv_obs(o).view(G, n_eval, -1)
            mean, tilt = net.act(x)
            eps = torch.randn(mean.shape, generator=gen, device=dev)
            z = torch.where(sample[..., None], mean + net.logstd.exp() * eps, mean)
            first = env.first.clone()
            env.setup(z[..., :4].reshape(n, 4), mask=first)
            env.ast_step(z[..., 4].reshape(n), tilt[..., 0].reshape(n), tilt[..., 1].reshape(n), obs=o)
            k += 1
    return env


def summarise_eval(case, env, groups, n_eval):
    rec = torch.stack(env.rec, 0)
    out = []
    fail = env.fail.view(len(groups), n_eval).cpu().numpy()
    lp = env.logp.view(len(groups), n_eval).cpu().numpy()
    fx = env.fx.view(len(groups), n_eval).cpu().numpy(); fy = env.fy.view(len(groups), n_eval).cpu().numpy()
    ft = env.ft.view(len(groups), n_eval).cpu().numpy()
    steps = (env.ft / A.DT).view(len(groups), n_eval).sum(1).cpu().numpy()
    for g in range(len(groups)):
        fm = fail[g] > 0
        items = [dict(**{"class": CLASSES[int(fail[g, i]) - 1]}, x=float(fx[g, i]), y=float(fy[g, i]), t=float(ft[g, i]),
                      log_p=float(lp[g, i]), idx=g * n_eval + int(i)) for i in np.nonzero(fm)[0]]
        top = distinct(items, 3)
        failures = [unpack_record(case, env, t["idx"], rec=rec) for t in top]
        best = max([q["log_p"] for q in items], default=None)
        sites = distinct(items, 50)
        half = n_eval // 2
        roll_idx = list(range(g * n_eval + half, g * n_eval + half + 32))
        rollouts = [unpack_record(case, env, i, rec=rec) for i in roll_idx]
        for q in rollouts:
            q.pop("trajectory_columns", None)
        pts = np.stack([fail[g][fm], fx[g][fm], fy[g][fm], ft[g][fm], lp[g][fm]], 1) if fm.any() else np.zeros((0, 5))
        out.append(dict(best_log_p=best, n=n_eval, sim_steps=int(steps[g]),
                        fail_rate_mean_action=float(fm[:half].mean()), fail_rate_sampled=float(fm[half:].mean()),
                        classes={c: int((fail[g] == i + 1).sum()) for i, c in enumerate(CLASSES)},
                        mean_log_p_failures=float(lp[g][fm].mean()) if fm.any() else None,
                        distinct_sites=len(sites), failures=failures, rollouts=rollouts, pts=pts))
    return out


def train(case, routes, seeds, falls_terminal=True, sig_scale=1.0, n_envs=8192, T=32, updates=150, lr=3e-4, lr_end=3e-5,
          gamma=1.0, lam=0.95, clip=0.2, ent_coef=0.003, vf_coef=0.5, epochs=4, minibatches=8, re=A.R_E, n_eval=2048,
          eval_every=25, tag="", verbose=True):
    dev = case.device
    groups = [(r, s) for r in routes for s in seeds]
    G = len(groups)
    n = G * n_envs
    torch.manual_seed(1234 + sum(seeds))
    net = Adversary(G, A.N_AOBS, [s + 10 * r for r, s in groups]).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=lr, eps=1e-5)
    env = ASTEnv(case, n, seed=4242 + sum(seeds), falls_terminal=falls_terminal, sig_scale=sig_scale, mode="adv")
    rid = torch.tensor([r for r, _ in groups], device=dev).repeat_interleave(n_envs)
    env.reset_routes(rid)
    gen = torch.Generator(device=dev); gen.manual_seed(777 + sum(seeds))
    D = A.N_AOBS
    buf = dict(x=torch.zeros(T, G, n_envs, D, device=dev), z=torch.zeros(T, G, n_envs, N_ACT, device=dev),
               first=torch.zeros(T, G, n_envs, dtype=torch.bool, device=dev), can=torch.zeros(T, G, n_envs, dtype=torch.bool, device=dev),
               fell=torch.zeros(T, G, n_envs, dtype=torch.bool, device=dev), inj=torch.zeros(T, G, n_envs, dtype=torch.bool, device=dev),
               lpF=torch.zeros(T, G, n_envs, device=dev), lpI=torch.zeros(T, G, n_envs, device=dev),
               logp=torch.zeros(T, G, n_envs, device=dev), val=torch.zeros(T, G, n_envs, device=dev),
               rew=torch.zeros(T, G, n_envs, device=dev), done=torch.zeros(T, G, n_envs, dtype=torch.bool, device=dev))
    best = np.full(G, -math.inf)
    steps = np.zeros(G)
    curves = [[] for _ in range(G)]
    logs = [[] for _ in range(G)]
    ring = [np.zeros((0, 5)) for _ in range(G)]
    scale = 0.1
    t0 = time.time()
    for u in range(updates):
        frac = u / max(1, updates - 1)
        for pg in opt.param_groups:
            pg["lr"] = lr + (lr_end - lr) * frac
        ep_ret = torch.zeros(G, device=dev); ep_n = torch.zeros(G, device=dev); ep_fail = torch.zeros(G, device=dev)
        with torch.no_grad():
            for t in range(T):
                o = env.observe()
                x = env.adv_obs(o).view(G, n_envs, D)
                if u < 20:
                    net.update_norm(x)
                mean, tilt = net.act(x)
                val = net.value(x)
                z = mean + net.logstd.exp() * torch.randn(mean.shape, generator=gen, device=dev)
                first = env.first.clone()
                lp_nom = env.setup(z[..., :4].reshape(n, 4), mask=first)
                lp_step, newly = env.ast_step(z[..., 4].reshape(n), tilt[..., 0].reshape(n), tilt[..., 1].reshape(n), obs=o)
                failed = newly & (env.fail > 0)
                r = lp_nom + lp_step + torch.where(failed, torch.full_like(lp_step, re),
                                                    torch.where(newly, -100.0 * env.miss_distance(), torch.zeros_like(lp_step)))
                pF = env.s_pFall.double().clamp(1e-12, 1 - 1e-9); pI = env.s_pInj.double().clamp(1e-12, 1 - 1e-9)
                lpF = torch.logit(pF).float().view(G, n_envs); lpI = torch.logit(pI).float().view(G, n_envs)
                fv = first.view(G, n_envs); can = env.s_can.view(G, n_envs); fell = env.s_fell.view(G, n_envs)
                inj = env.s_inj.view(G, n_envs)
                logp, _ = policy_logp(mean, net.logstd, tilt, z, fv, can, fell, inj, lpF, lpI, falls_terminal)
                buf["x"][t] = x; buf["z"][t] = z; buf["first"][t] = fv; buf["can"][t] = can; buf["fell"][t] = fell; buf["inj"][t] = inj
                buf["lpF"][t] = lpF; buf["lpI"][t] = lpI; buf["logp"][t] = logp; buf["val"][t] = val
                buf["rew"][t] = (r.float() * scale).view(G, n_envs); buf["done"][t] = newly.view(G, n_envs)
                # bookkeeping of finished episodes
                if bool(newly.any()):
                    nv = newly.view(G, n_envs)
                    ep_n += nv.sum(1); ep_fail += failed.view(G, n_envs).sum(1)
                    tot = env.logp + torch.where(failed, torch.full_like(env.logp, re), -100.0 * env.miss_distance())
                    ep_ret += torch.where(newly, tot, torch.zeros_like(tot)).float().view(G, n_envs).sum(1)
                    if bool(failed.any()):
                        lpf = torch.where(failed, env.logp, torch.full_like(env.logp, -math.inf)).view(G, n_envs)
                        mx, am = lpf.max(1)
                        mxn = mx.cpu().numpy()
                        for g in range(G):
                            if mxn[g] > best[g]:
                                best[g] = float(mxn[g])
                        if t % 8 == 0:
                            fidx = torch.nonzero(failed).squeeze(1)
                            if fidx.numel() > 4096:
                                fidx = fidx[torch.randperm(fidx.numel(), device=dev)[:4096]]
                            pts = torch.stack([env.fail[fidx].double(), env.fx[fidx].double(), env.fy[fidx].double(), env.ft[fidx].double(),
                                               env.logp[fidx]], 1).cpu().numpy()
                            gi = (fidx // n_envs).cpu().numpy()
                            for g in range(G):
                                if (gi == g).any():
                                    ring[g] = np.concatenate([ring[g], pts[gi == g]], 0)[-4096:]
                    env.reset_routes(mask=newly)
            o = env.observe()
            last_val = net.value(env.adv_obs(o).view(G, n_envs, D))
            adv = torch.zeros_like(buf["rew"]); gae = torch.zeros(G, n_envs, device=dev)
            for t in reversed(range(T)):
                nonterm = (~buf["done"][t]).float()
                nv = last_val if t == T - 1 else buf["val"][t + 1]
                delta = buf["rew"][t] + gamma * nv * nonterm - buf["val"][t]
                gae = delta + gamma * lam * nonterm * gae
                adv[t] = gae
            ret = adv + buf["val"]
        steps += T * n_envs
        # ---------------------------------------------------------------- PPO update
        B = T * n_envs
        flat = {k: v.transpose(0, 1).reshape(G, B, *v.shape[3:]) for k, v in buf.items()}
        fadv = adv.transpose(0, 1).reshape(G, B); fret = ret.transpose(0, 1).reshape(G, B)
        kls = []
        for ep in range(epochs):
            perm = torch.randperm(B, device=dev)
            for mb in perm.chunk(minibatches):
                x = flat["x"][:, mb]
                mean, tilt = net.act(x)
                logp, ent = policy_logp(mean, net.logstd, tilt, flat["z"][:, mb], flat["first"][:, mb], flat["can"][:, mb],
                                        flat["fell"][:, mb], flat["inj"][:, mb], flat["lpF"][:, mb], flat["lpI"][:, mb], falls_terminal)
                a = fadv[:, mb]
                a = (a - a.mean(1, keepdim=True)) / (a.std(1, keepdim=True) + 1e-8)
                ratio = (logp - flat["logp"][:, mb]).exp()
                pg_loss = -torch.min(ratio * a, ratio.clamp(1 - clip, 1 + clip) * a).mean(1)
                v = net.value(x)
                v_loss = 0.5 * ((v - fret[:, mb]) ** 2).mean(1)
                loss = (pg_loss + vf_coef * v_loss - ent_coef * ent.mean(1)).sum()
                opt.zero_grad(set_to_none=True)
                loss.backward()
                with torch.no_grad():
                    sq = torch.zeros(G, device=dev)
                    for p_ in net.parameters():
                        if p_.grad is not None:
                            sq += (p_.grad.reshape(G, -1) ** 2).sum(1)
                    sc = (0.5 / (sq.sqrt() + 1e-8)).clamp(max=1.0)
                    for p_ in net.parameters():
                        if p_.grad is not None:
                            p_.grad.mul_(sc.view(G, *([1] * (p_.grad.dim() - 1))))
                    kls.append((flat["logp"][:, mb] - logp).mean(1))
                opt.step()
        with torch.no_grad():
            kl = torch.stack(kls[-minibatches:], 0).mean(0).cpu().numpy()
            ev = (1 - (fret - flat["val"]).var(1) / (fret.var(1) + 1e-8)).cpu().numpy()
            mret = (ep_ret / ep_n.clamp_min(1)).cpu().numpy(); fr = (ep_fail / ep_n.clamp_min(1)).cpu().numpy()
            sd = net.logstd.exp().mean((1, 2)).cpu().numpy()
        for g in range(G):
            curves[g].append([int(steps[g]), best[g] if math.isfinite(best[g]) else None])
            logs[g].append([u, int(steps[g]), round(float(mret[g]), 3), round(float(fr[g]), 4), best[g] if math.isfinite(best[g]) else None,
                            round(float(sd[g]), 4), round(float(kl[g]), 5), round(float(ev[g]), 4)])
        if verbose and (u % 10 == 0 or u == updates - 1):
            print("  update %3d  %.1fM steps/adversary  %5.0f s | " % (u, steps[0] / 1e6, time.time() - t0) + " | ".join(
                "r%d s%d ret %.1f fail %.2f best %s sd %.2f" % (groups[g][0], groups[g][1], mret[g], fr[g],
                                                               "%.2f" % best[g] if math.isfinite(best[g]) else "none", sd[g])
                for g in range(G)), flush=True)
        if (u + 1) % eval_every == 0 and u + 1 < updates:
            ev_env = evaluate_policy(case, net, groups, falls_terminal, sig_scale, 1024, seed=90000 + u)
            lpf = torch.where(ev_env.fail > 0, ev_env.logp, torch.full_like(ev_env.logp, -math.inf)).view(G, 1024).max(1).values.cpu().numpy()
            st = (ev_env.ft / A.DT).view(G, 1024).sum(1).cpu().numpy()
            for g in range(G):
                steps[g] += st[g]
                if lpf[g] > best[g]:
                    best[g] = float(lpf[g])
                curves[g].append([int(steps[g]), best[g] if math.isfinite(best[g]) else None])
            del ev_env
    # ---------------------------------------------------------------- final evaluation on fresh seeds
    ev_env = evaluate_policy(case, net, groups, falls_terminal, sig_scale, n_eval, seed=555000 + sum(seeds))
    evs = summarise_eval(case, ev_env, groups, n_eval)
    res = []
    for g, (r, s) in enumerate(groups):
        e = evs[g]
        steps[g] += e["sim_steps"]
        if e["best_log_p"] is not None and e["best_log_p"] > best[g]:
            best[g] = e["best_log_p"]
        curves[g].append([int(steps[g]), best[g] if math.isfinite(best[g]) else None])
        pts = np.concatenate([ring[g], e.pop("pts")], 0)
        res.append(dict(route_index=r, seed=s, best_log_p=best[g] if math.isfinite(best[g]) else None, curve=curves[g],
                        log_columns=["update", "env_steps", "mean_return_nats", "failure_rate", "best_log_p", "mean_std", "kl", "explained_variance"],
                        log=logs[g][::max(1, len(logs[g]) // 60)], eval=e, pts=pts, sim_steps=int(steps[g])))
    os.makedirs(RUNS, exist_ok=True)
    torch.save(dict(state=net.state_dict(), groups=groups, falls_terminal=falls_terminal, sig_scale=sig_scale, n_obs=D, re=re),
               os.path.join(RUNS, "ckpt_ppo_%s_%s%s.pt" % (case.scenario, cfg_name(falls_terminal), tag)))
    print("  trained %d adversaries, %.1fM steps each, %.0f s (%.0fk steps/s overall)" % (
        G, steps[0] / 1e6, time.time() - t0, steps.sum() / (time.time() - t0) / 1e3), flush=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="S1")
    ap.add_argument("--routes", type=int, nargs="*", default=None, help="route indices (default: every feasible route)")
    ap.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    ap.add_argument("--envs", type=int, default=8192)
    ap.add_argument("--rollout", type=int, default=32)
    ap.add_argument("--updates", type=int, default=150)
    ap.add_argument("--penalty", action="store_true")
    ap.add_argument("--both", action="store_true")
    ap.add_argument("--sig-scale", type=float, default=1.0)
    ap.add_argument("--re", type=float, default=A.R_E)
    ap.add_argument("--gamma", type=float, default=1.0)
    ap.add_argument("--ent", type=float, default=0.003)
    ap.add_argument("--tag", default="")
    args = ap.parse_args()
    device = torch.device("cuda")
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    print("device", torch.cuda.get_device_name(0), flush=True)
    case = Case(args.scenario, device)
    for terminal in ([True, False] if args.both else [not args.penalty]):
        nominal = A.nominal_runs(case, terminal)
        routes = args.routes if args.routes else [r for r in range(case.R) if A.feasible(nominal[r])]
        print("PPO adversary %s, %s: routes %s, seeds %s, %d envs x %d steps x %d updates = %.1fM steps per adversary, R_E %.0f" % (
            args.scenario, cfg_name(terminal), routes, args.seeds, args.envs, args.rollout, args.updates,
            args.envs * args.rollout * args.updates / 1e6, args.re), flush=True)
        res = train(case, routes, args.seeds, terminal, args.sig_scale, args.envs, args.rollout, args.updates, re=args.re,
                    gamma=args.gamma, ent_coef=args.ent, tag=args.tag)
        out = [None] * case.R
        pts = {}
        for r in routes:
            mine = [q for q in res if q["route_index"] == r]
            bi = int(np.argmax([q["best_log_p"] if q["best_log_p"] is not None else -1e9 for q in mine]))
            bl = mine[bi]["best_log_p"]
            pts["r%d" % r] = np.concatenate([q.pop("pts") for q in mine], 0)
            ev = mine[bi]["eval"]
            out[r] = dict(route=case.routes[r]["id"], shelter=case.routes[r]["shelter"], best_log_p=bl,
                          robustness_nats=None if bl is None else -bl, shipped_seed=mine[bi]["seed"],
                          failures=ev["failures"], rollouts=ev["rollouts"],
                          eval=dict(n=ev["n"], fail_rate_mean_action=ev["fail_rate_mean_action"], fail_rate_sampled=ev["fail_rate_sampled"],
                                    classes=ev["classes"], distinct_sites=ev["distinct_sites"], best_log_p=ev["best_log_p"]),
                          seeds=[dict(seed=q["seed"], best_log_p=q["best_log_p"], curve=q["curve"], log_columns=q["log_columns"], log=q["log"],
                                      sim_steps=q["sim_steps"],
                                      eval=dict(best_log_p=q["eval"]["best_log_p"], fail_rate_mean_action=q["eval"]["fail_rate_mean_action"],
                                                fail_rate_sampled=q["eval"]["fail_rate_sampled"], classes=q["eval"]["classes"],
                                                distinct_sites=q["eval"]["distinct_sites"])) for q in mine])
            print("  => %s: PPO best failure log p per seed %s; shipped seed %d; top: %s" % (
                case.route_name(r), ["none" if q["best_log_p"] is None else "%.2f" % q["best_log_p"] for q in mine], mine[bi]["seed"],
                " | ".join("%s %.1f (%s)" % (f["class"], f["log_p"], f["summary"]) for f in ev["failures"])), flush=True)
        name = "ppo_%s_%s%s" % (args.scenario, cfg_name(terminal), args.tag)
        with open(os.path.join(RUNS, name + ".json"), "w") as f:
            json.dump(dict(scenario=args.scenario, config=cfg_name(terminal), sig_scale=args.sig_scale, R_E=args.re, seeds=args.seeds,
                           envs=args.envs, rollout=args.rollout, updates=args.updates, gamma=args.gamma,
                           network="actor MLP 2 x 128 tanh, critic MLP 2 x 256 tanh, orthogonal init", routes=out,
                           failure_definitions=A.FAILURE_DEFS, assumptions=A.ASSUMPTIONS), f, default=float)
        np.savez_compressed(os.path.join(RUNS, name + ".npz"), **pts)


if __name__ == "__main__":
    main()

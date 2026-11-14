"""PPO for the virtual-crew walking policy (rl/SPEC.md) on the vectorised reference environment (rl/env.py).

    python rl/train_ppo.py --name run1 --updates 300

Policy: tanh MLP 44 -> 64 -> 64 -> 10 (5 heading logits + 5 pace logits), exported to the browser.
Critic: separate tanh MLP; training-only, also sees a few privileged scalars (risk-weighted cost-to-go,
elapsed time, the randomised parameters) because the progress reward is defined on the planner's
cost-to-go, which the 44-float observation does not contain.
"""
import argparse, csv, json, math, os, sys, time
import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env as E
from terrain import ROOT

N_PRIV = 9


def layer(nin, nout, gain):
    l = nn.Linear(nin, nout)
    nn.init.orthogonal_(l.weight, gain)
    nn.init.zeros_(l.bias)
    return l


class Policy(nn.Module):
    def __init__(self, hidden=(64, 64)):
        super().__init__()
        dims = [E.N_OBS] + list(hidden)
        mods = []
        for a, b in zip(dims[:-1], dims[1:]):
            mods += [layer(a, b, math.sqrt(2)), nn.Tanh()]
        mods.append(layer(dims[-1], 10, 0.01))
        self.net = nn.Sequential(*mods)

    def forward(self, obs):
        return self.net(obs)


class Critic(nn.Module):
    def __init__(self, hidden=(256, 256)):
        super().__init__()
        dims = [E.N_OBS + N_PRIV] + list(hidden)
        mods = []
        for a, b in zip(dims[:-1], dims[1:]):
            mods += [layer(a, b, math.sqrt(2)), nn.Tanh()]
        mods.append(layer(dims[-1], 1, 1.0))
        self.net = nn.Sequential(*mods)

    def forward(self, obs, priv):
        return self.net(torch.cat([obs, priv], -1)).squeeze(-1)


def privileged(env):
    """Critic-only inputs (never exported)."""
    T, B = env.T, env.B
    c, ok = T.cell_at(env.x, env.y)
    ct = B.ct[env.fidx * T.N + c]
    cost = torch.nan_to_num(ct[:, 0], posinf=7200.0 * 9).clamp(max=7200.0 * 9)
    tim = torch.nan_to_num(ct[:, 1], posinf=7200.0 * 2).clamp(max=7200.0 * 2)
    p = env.p
    cols = [cost / 3600.0, torch.log1p(cost / 600.0), tim / 3600.0, env.t.float() / 3600.0,
            (env.fallPerKm / p["fallPerKm"]).float() - 1, (env.coolW / p["coolW"]).float() - 1,
            env.alpha.float() / 30.0 - 0.9, env.band_active.float(), env.terr_err.float()]
    return torch.stack(cols, -1)


def sample_actions(logits, gen=None):
    """Two independent categoricals (heading, pace) -> actions, log-prob."""
    lh = torch.log_softmax(logits[:, :5], -1); lp = torch.log_softmax(logits[:, 5:], -1)
    uh = torch.rand(lh.shape, device=logits.device, generator=gen).clamp_min(1e-12)
    up = torch.rand(lp.shape, device=logits.device, generator=gen).clamp_min(1e-12)
    h = (lh - torch.log(-torch.log(uh))).argmax(-1)
    p = (lp - torch.log(-torch.log(up))).argmax(-1)
    logp = lh.gather(1, h[:, None]).squeeze(1) + lp.gather(1, p[:, None]).squeeze(1)
    return h, p, logp


def evaluate_logp(logits, h, p):
    lh = torch.log_softmax(logits[:, :5], -1); lp = torch.log_softmax(logits[:, 5:], -1)
    logp = lh.gather(1, h[:, None]).squeeze(1) + lp.gather(1, p[:, None]).squeeze(1)
    ent = -(lh.exp() * lh).sum(-1) - (lp.exp() * lp).sum(-1)
    return logp, ent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="run1")
    ap.add_argument("--envs", type=int, default=8192)
    ap.add_argument("--rollout", type=int, default=128)
    ap.add_argument("--updates", type=int, default=300)
    ap.add_argument("--gamma", type=float, default=0.995)
    ap.add_argument("--lam", type=float, default=0.95)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--ent0", type=float, default=0.01)
    ap.add_argument("--ent1", type=float, default=0.003)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--lr_end", type=float, default=3e-5)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--minibatches", type=int, default=32)
    ap.add_argument("--vf_coef", type=float, default=0.5)
    ap.add_argument("--max_grad", type=float, default=0.5)
    ap.add_argument("--rew_scale", type=float, default=0.1)
    ap.add_argument("--target_kl", type=float, default=0.03)
    ap.add_argument("--hidden", type=int, nargs="+", default=[64, 64])
    ap.add_argument("--n_random_goals", type=int, default=24)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--init", default="")
    ap.add_argument("--casualty", type=float, default=E.REWARD["casualty"])
    ap.add_argument("--fall", type=float, default=E.REWARD["fall"])
    ap.add_argument("--timeout_pen", type=float, default=E.REWARD["timeout"])
    ap.add_argument("--in_rule", type=float, default=E.REWARD["in_rule"])
    ap.add_argument("--shaping", default="spec", choices=["spec", "potential"])
    ap.add_argument("--shaping_k", type=float, default=0.5)
    ap.add_argument("--save_every", type=int, default=25)
    a = ap.parse_args()

    torch.manual_seed(a.seed); np.random.seed(a.seed)
    dev = torch.device("cuda")
    out = os.path.join(ROOT, "rl", "runs", a.name)
    os.makedirs(out, exist_ok=True)
    g, blocked, T = E.make_world(dev, torch.float64)          # float64 state: step-for-step parity with sim.ts
    bank, goals = E.build_bank(g, blocked, dev, n_random=a.n_random_goals)
    reward = dict(E.REWARD); reward["casualty"] = a.casualty; reward["fall"] = a.fall; reward["timeout"] = a.timeout_pen; reward["in_rule"] = a.in_rule
    reward.update(shaping=a.shaping, shaping_k=a.shaping_k, gamma=a.gamma)
    env = E.WalkEnv(T, bank, a.envs, seed=a.seed, reward=reward)
    pi = Policy(tuple(a.hidden)).to(dev); vf = Critic().to(dev)
    if a.init:
        ck = torch.load(a.init, map_location=dev, weights_only=False)
        pi.load_state_dict(ck["pi"]); vf.load_state_dict(ck["vf"])
    opt = torch.optim.Adam(list(pi.parameters()) + list(vf.parameters()), lr=a.lr, eps=1e-5)
    N, TT = a.envs, a.rollout
    cfg = dict(vars(a)); cfg.update(dict(obs=E.N_OBS, n_priv=N_PRIV, fields=bank.F, goals=[list(x) for x in goals], reward=reward, scen=E.SCEN,
                                         params=env.p, state_dtype="float64", value_clip=False,
                                         critic="MLP %d->256->256->1 (tanh), training only, privileged inputs" % (E.N_OBS + N_PRIV)))
    json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=1)
    obs_b = torch.zeros((TT, N, E.N_OBS), device=dev); priv_b = torch.zeros((TT, N, N_PRIV), device=dev)
    h_b = torch.zeros((TT, N), device=dev, dtype=torch.long); p_b = torch.zeros((TT, N), device=dev, dtype=torch.long)
    logp_b = torch.zeros((TT, N), device=dev); rew_b = torch.zeros((TT, N), device=dev)
    done_b = torch.zeros((TT, N), device=dev); val_b = torch.zeros((TT, N), device=dev)
    obs = env.observe(); priv = privileged(env)
    fcsv = open(os.path.join(out, "log.csv"), "w", newline="")
    wcsv = None
    t_start = time.time()
    steps = 0
    for upd in range(1, a.updates + 1):
        frac = (upd - 1) / max(1, a.updates - 1)
        lr = a.lr + (a.lr_end - a.lr) * frac
        ent_coef = a.ent0 + (a.ent1 - a.ent0) * frac
        for gph in opt.param_groups: gph["lr"] = lr
        t0 = time.time()
        with torch.no_grad():
            for t in range(TT):
                obs_b[t] = obs; priv_b[t] = priv
                logits = pi(obs)
                h, p, logp = sample_actions(logits)
                val_b[t] = vf(obs, priv)
                obs, rew, done = env.step(h, p)
                priv = privileged(env)
                h_b[t] = h; p_b[t] = p; logp_b[t] = logp
                rew_b[t] = rew * a.rew_scale; done_b[t] = done.float()
            last_v = vf(obs, priv)
            adv = torch.zeros_like(rew_b)
            gae = torch.zeros(N, device=dev)
            for t in reversed(range(TT)):
                nv = last_v if t == TT - 1 else val_b[t + 1]
                nd = 1.0 - done_b[t]
                delta = rew_b[t] + a.gamma * nv * nd - val_b[t]
                gae = delta + a.gamma * a.lam * nd * gae
                adv[t] = gae
            ret = adv + val_b
        steps += N * TT
        t_roll = time.time() - t0
        B_obs = obs_b.reshape(-1, E.N_OBS); B_priv = priv_b.reshape(-1, N_PRIV)
        B_h = h_b.reshape(-1); B_p = p_b.reshape(-1); B_logp = logp_b.reshape(-1)
        B_adv = adv.reshape(-1); B_ret = ret.reshape(-1); B_val = val_b.reshape(-1)
        nb = N * TT; mb = nb // a.minibatches
        kls, pls, vls, ents = [], [], [], []
        stop = False
        for ep in range(a.epochs):
            perm = torch.randperm(nb, device=dev)
            for k in range(a.minibatches):
                idx = perm[k * mb:(k + 1) * mb]
                logits = pi(B_obs[idx])
                logp, ent = evaluate_logp(logits, B_h[idx], B_p[idx])
                ad = B_adv[idx]; ad = (ad - ad.mean()) / (ad.std() + 1e-8)
                ratio = torch.exp(logp - B_logp[idx])
                pl = -torch.min(ratio * ad, torch.clamp(ratio, 1 - a.clip, 1 + a.clip) * ad).mean()
                v = vf(B_obs[idx], B_priv[idx])
                vl = 0.5 * ((v - B_ret[idx]) ** 2).mean()
                loss = pl + a.vf_coef * vl - ent_coef * ent.mean()
                opt.zero_grad(set_to_none=True)
                loss.backward()
                nn.utils.clip_grad_norm_(list(pi.parameters()) + list(vf.parameters()), a.max_grad)
                opt.step()
                with torch.no_grad():
                    kl = (B_logp[idx] - logp).mean()
                kls.append(kl); pls.append(pl.detach()); vls.append(vl.detach()); ents.append(ent.mean().detach())
            if a.target_kl > 0 and torch.stack(kls[-a.minibatches:]).mean().item() > a.target_kl:
                stop = True
            if stop: break
        ev = 1 - (B_ret - B_val).var() / (B_ret.var() + 1e-8)
        st = env.pop_stats()
        row = dict(update=upd, env_steps=steps, wall_s=round(time.time() - t_start, 1), fps=int(N * TT / (time.time() - t0)),
                   roll_s=round(t_roll, 2), lr=lr, ent_coef=ent_coef, entropy=torch.stack(ents).mean().item(),
                   kl=torch.stack(kls).mean().item(), ploss=torch.stack(pls).mean().item(), vloss=torch.stack(vls).mean().item(),
                   explained_var=ev.item(), epochs_run=ep + 1, **st)
        if wcsv is None:
            wcsv = csv.DictWriter(fcsv, fieldnames=list(row.keys())); wcsv.writeheader()
        wcsv.writerow(row); fcsv.flush()
        if upd % 5 == 0 or upd == 1:
            print("upd %4d  steps %.1fM  %5.0fs  fps %dk | ret %7.2f  arrive %.3f  in-rule %.3f  incap %.3f  heat %.3f  o2 %.3f  timeout %.3f  stuck %.3f  falls %.2f  t %.1f min (plan %.1f) | ent %.3f kl %.4f ev %.2f ep %d"
                  % (upd, steps / 1e6, time.time() - t_start, row["fps"] / 1000, st["ret"], st["arrive"], st["in_rule"], st["incap"], st["heat"],
                     st["o2"], st["timeout"], st["stuck"], st["falls"], st["t_arrive_min"], st["plan_min"], row["entropy"], row["kl"], row["explained_var"], ep + 1), flush=True)
        if upd % a.save_every == 0 or upd == a.updates:
            ck = dict(pi=pi.state_dict(), vf=vf.state_dict(), update=upd, env_steps=steps, wall_s=time.time() - t_start, hidden=list(a.hidden), cfg=cfg, last=row)
            torch.save(ck, os.path.join(out, "ckpt_%04d.pt" % upd)); torch.save(ck, os.path.join(out, "latest.pt"))
    fcsv.close()
    print("done: %d env steps in %.0f s" % (steps, time.time() - t_start), flush=True)


if __name__ == "__main__":
    main()

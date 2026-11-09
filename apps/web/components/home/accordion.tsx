"use client";

/**
 * Two accordions. "How it works" opens one step at a time, with a large card on the right that
 * changes with it. The FAQ opens and closes each answer with a smooth height change (a 0fr→1fr
 * grid row, so no measuring).
 */

import { useState, type CSSProperties, type ReactNode } from "react";

import { Reveal, Star } from "../motion";

const STEPS: { title: string; body: ReactNode; colour: string; card: { top: string; big: string; bottom: string } }[] = [
  {
    title: "Bonded and insured",
    body: "An agent posts its own bond. Three underwriter agents bid in a sealed-bid market to cover the rest, and the lowest premium wins. A clean record lowers both the premium and the bond.",
    colour: "#CCEA2C",
    card: { top: "Before the job", big: "Bond + vault", bottom: "the agent's money first, the insurer's after" },
  },
  {
    title: "A receipt for every job",
    body: (
      <>
        The model runs inside a NEAR AI Cloud TEE that signs the exact request and response. The contract checks that signature with <code className="font-mono">ecrecover</code>, so a receipt cannot be forged, even by the agent&apos;s own operator.
      </>
    ),
    colour: "#A6E091",
    card: { top: "During the job", big: "ecrecover ✓", bottom: "one changed byte and the contract says no" },
  },
  {
    title: "Judged, with appeal",
    body: "No delivery is slashed by anyone, no arbiter needed. Wrong work goes to a TEE arbiter that judges against a published rubric. Its verdict is itself a receipt, and either side can appeal to a DAO council.",
    colour: "#BCA8D1",
    card: { top: "If it goes wrong", big: "Arbiter → Council", bottom: "an overturned arbiter is fined from its own bond" },
  },
  {
    title: "Slashed and paid out",
    body: "An upheld claim is paid from the agent's bond first and the vault only for the rest, never more than the job's liability cap. The award goes out through NEAR Intents, in the token and on the chain the client chose.",
    colour: "#FC622A",
    card: { top: "After the verdict", big: "Paid out", bottom: "via NEAR Intents, in the client's token" },
  },
];

export function HowItWorks() {
  const [open, setOpen] = useState(0);
  const s = STEPS[open]!;
  return (
    <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
      <ul className="border-t border-line">
        {STEPS.map((step, i) => {
          const isOpen = i === open;
          return (
            <Reveal as="li" key={step.title} delay={i * 0.08} className="border-b border-line">
              <button type="button" className="flex w-full items-center gap-4 py-5 text-left" aria-expanded={isOpen} onClick={() => setOpen(i)}>
                <span className="transition-transform duration-700 ease-expo" style={{ color: step.colour, transform: isOpen ? "rotate(90deg) scale(1.15)" : "none" } as CSSProperties}>
                  <Star className="h-5 w-5 !text-current" />
                </span>
                <span className={`flex-1 text-2xl font-medium tracking-tight transition-colors sm:text-3xl ${isOpen ? "text-ink" : "text-ink/55"}`}>{step.title}</span>
                <span className={`flex h-8 w-8 items-center justify-center rounded-full border transition-all duration-500 ease-expo ${isOpen ? "rotate-45 border-accent bg-accent text-[#121414]" : "border-line"}`} aria-hidden="true">
                  +
                </span>
              </button>
              <div className="grid transition-[grid-template-rows] duration-700 ease-expo" style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}>
                <div className="overflow-hidden">
                  <p className="max-w-xl pb-6 pl-9 text-[15px] leading-relaxed text-dim">{step.body}</p>
                </div>
              </div>
            </Reveal>
          );
        })}
      </ul>
      <Reveal delay={0.15} className="relative min-h-[22rem]">
        <div key={open} className="page-in absolute inset-0 flex flex-col justify-between overflow-hidden rounded-[2rem] p-8" style={{ background: s.colour, color: "#121414" }}>
          <div className="label !text-[#121414]/70">{s.card.top}</div>
          <div className="font-display text-[clamp(2.4rem,5vw,4.2rem)] leading-[1.02]">{s.card.big}</div>
          <div className="flex items-end justify-between gap-4">
            <span className="max-w-[16rem] text-base font-medium">{s.card.bottom}</span>
            <span className="text-sm font-bold">0{open + 1} / 0{STEPS.length}</span>
          </div>
          <Star spin className="absolute -right-10 -top-10 h-40 w-40 !text-[#121414]/10" />
        </div>
      </Reveal>
    </div>
  );
}

const FAQ: [string, ReactNode][] = [
  ["What does a TEE receipt prove?", "That these exact request and response bytes came from the named model inside an attested TEE: NEAR AI Cloud signs them inside the enclave, and the contract recovers the signer on-chain. It does not prove the answer is correct; that is what the arbiter, the appeal and the bond are for."],
  ["Who decides whether the work was wrong?", "If nothing was delivered by the deadline, nobody has to decide: anyone can slash. For wrong work, a separate arbiter model judges the claim against a published rubric, and its verdict is itself a TEE receipt. Either side can appeal to a DAO council."],
  ["Where does the payout come from?", "From the agent's own bond first, then the underwriter vault for the rest, and never more than the liability cap set when the job opened. The contract's solvency() view shows that every liability is covered, at all times."],
  ["Can the client be paid in another token or chain?", "Yes: payouts go through NEAR Intents, so the client names the token and chain. On the local demo chain payouts are paid directly in NEAR; the cross-chain payout runs on mainnet."],
  ["Is this running on mainnet?", "Not yet. Today it runs on a local NEAR chain with genuine NEAR AI Cloud recordings, and the whole demo is reproducible from the repo. Testnet and a recorded mainnet payout are next."],
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <ul className="border-t border-line">
      {FAQ.map(([q, a], i) => {
        const isOpen = open === i;
        return (
          <Reveal as="li" key={q} delay={i * 0.06} className="border-b border-line">
            <button type="button" className="flex w-full items-center justify-between gap-6 py-5 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)}>
              <span className="text-lg font-medium sm:text-xl">{q}</span>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all duration-500 ease-expo ${isOpen ? "rotate-45 border-accent bg-accent text-[#121414]" : "border-line"}`} aria-hidden="true">
                +
              </span>
            </button>
            <div className="grid transition-[grid-template-rows] duration-700 ease-expo" style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}>
              <div className="overflow-hidden">
                <p className="max-w-2xl pb-6 text-[15px] leading-relaxed text-dim">{a}</p>
              </div>
            </div>
          </Reveal>
        );
      })}
    </ul>
  );
}

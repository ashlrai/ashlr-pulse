"use client";

/**
 * Reveal.tsx — declarative scroll-triggered fade-up wrapper.
 *
 * Use around a section or block to make it animate in once it scrolls
 * into view. Plays once (whileInView + viewport.once: true) so the page
 * doesn't replay animations as the user scrolls back up.
 */

import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

const variants: Variants = {
  hidden:  { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.2, 0.8, 0.2, 1] } },
};

export function Reveal({
  children,
  delay = 0,
  as: As = "div",
}: {
  children: ReactNode;
  delay?: number;
  as?: "div" | "section" | "header" | "footer";
}) {
  const Component = motion[As];
  return (
    <Component
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-80px" }}
      variants={variants}
      transition={{ delay }}
    >
      {children}
    </Component>
  );
}

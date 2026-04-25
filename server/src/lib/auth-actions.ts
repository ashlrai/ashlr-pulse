/**
 * auth-actions.ts — server actions for authentication flows.
 */

"use server";

import { redirect } from "next/navigation";
import { server } from "@/lib/supabase-server";

/**
 * Sign out the current session and redirect to /login.
 * Safe to call from any Server Component form action.
 */
export async function signOutAction(): Promise<never> {
  const supabase = await server();
  await supabase.auth.signOut();
  redirect("/login");
}

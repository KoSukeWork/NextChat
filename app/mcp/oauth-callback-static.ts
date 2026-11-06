// The desktop app uses its loopback listener; this route exists only on web.
export const dynamic = "force-static";
export async function GET() {
  return new Response("Not available", { status: 404 });
}

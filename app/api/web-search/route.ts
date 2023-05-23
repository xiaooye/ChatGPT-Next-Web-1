import { NextRequest, NextResponse } from "next/server";

const WEB_SEARCH_BASE_URL = process.env.WEB_SEARCH_BASE_URL;
const WEB_SEARCH_GOOGLE_API_KEY = process.env.WEB_SEARCH_GOOGLE_API_KEY;
const WEB_SEARCH_GOOGLE_SEARCH_ENGINE_ID =
  process.env.WEB_SEARCH_GOOGLE_SEARCH_ENGINE_ID;

async function makeRequest(req: NextRequest) {
  try {
    const content = req.nextUrl.searchParams.get("query");
    console.log(content);
    if (!console) return;
    const query = encodeURIComponent(content!);
    const api = await fetch(
      `${WEB_SEARCH_BASE_URL}/v1?key=${WEB_SEARCH_GOOGLE_API_KEY}&cx=${WEB_SEARCH_GOOGLE_SEARCH_ENGINE_ID}&q=${query}&num=5&fields=items(title,formattedUrl,snippet)`,
    );
    const res = new NextResponse(api.body);
    res.headers.set("Content-Type", "application/json");
    res.headers.set("Cache-Control", "no-cache");
    res.headers.set("Accept-Encoding", "gzip");
    return res;
  } catch (e) {
    console.error("[OpenAI] ", req.body, e);
    return NextResponse.json(
      {
        error: true,
        msg: JSON.stringify(e),
      },
      {
        status: 500,
      },
    );
  }
}

export async function GET(req: NextRequest) {
  return makeRequest(req);
}

export const runtime = "edge";

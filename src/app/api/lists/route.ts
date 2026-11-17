import { NextRequest, NextResponse } from "next/server";
import { getLists, addList, deleteList, addListItem, toggleListItem, deleteListItem } from "@/lib/queries";

export const dynamic = "force-dynamic";

// Shared family lists — no PIN, anyone at the wall can edit.
export async function GET() {
  return NextResponse.json({ lists: getLists() });
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  switch (b.action) {
    case "add_list":
      if (typeof b.name !== "string" || !b.name.trim()) return NextResponse.json({ error: "Name it first" }, { status: 400 });
      addList(b.name.trim(), typeof b.color === "string" ? b.color : "#6E9BBD");
      break;
    case "delete_list":
      if (!Number.isInteger(Number(b.id))) return NextResponse.json({ error: "Invalid" }, { status: 400 });
      deleteList(Number(b.id));
      break;
    case "add_item":
      if (!Number.isInteger(Number(b.listId)) || typeof b.label !== "string" || !b.label.trim())
        return NextResponse.json({ error: "Invalid" }, { status: 400 });
      addListItem(Number(b.listId), typeof b.section === "string" ? b.section : "General", b.label.trim());
      break;
    case "toggle":
      if (!Number.isInteger(Number(b.id))) return NextResponse.json({ error: "Invalid" }, { status: 400 });
      toggleListItem(Number(b.id));
      break;
    case "delete_item":
      if (!Number.isInteger(Number(b.id))) return NextResponse.json({ error: "Invalid" }, { status: 400 });
      deleteListItem(Number(b.id));
      break;
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, lists: getLists() });
}

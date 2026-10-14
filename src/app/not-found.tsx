import Link from "next/link";
import { TopBar } from "@/components/Brand";

export default function NotFound() {
  return (
    <>
      <TopBar />
      <main className="page narrow stack">
        <h1>Nothing kept here.</h1>
        <p className="lead">This page does not exist.</p>
        <Link className="btn" href="/">Back to Hearth</Link>
      </main>
    </>
  );
}

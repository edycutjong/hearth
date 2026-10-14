import { TopBar } from "@/components/Brand";
import { HearthApp } from "@/components/HearthApp";

export default function Home() {
  return (
    <>
      <TopBar current="app" />
      <main className="page">
        <HearthApp />
      </main>
    </>
  );
}

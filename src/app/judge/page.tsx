import { TopBar } from "@/components/Brand";
import { JudgeSample } from "@/components/JudgeSample";
import { benchSummary, liveWait } from "@/lib/bench";
import { getSample } from "@/lib/sample";

export const metadata = { title: "Hearth — judge sample" };

export default function Judge() {
  return (
    <>
      <TopBar current="judge" chip="no account · no cap · real Nebius job" />
      <main className="page">
        <JudgeSample sample={getSample()} bench={benchSummary()} wait={liveWait()} />
      </main>
    </>
  );
}

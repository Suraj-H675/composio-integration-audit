import presentationData from "../data/presentation.json";
import CaseStudy, { type PresentationData } from "../components/CaseStudy";

export default function Home() {
  return <CaseStudy data={presentationData as unknown as PresentationData} />;
}

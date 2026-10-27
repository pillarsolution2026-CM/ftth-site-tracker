import { CadFileList } from '@/features/cad-files/components/cad-file-list';

export default async function CadFilesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <CadFileList projectId={projectId} />;
}

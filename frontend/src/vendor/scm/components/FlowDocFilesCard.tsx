// The Files card on a Goods Received, Purchase Invoice, Delivery Return or
// Purchase Return: DocFilesCard bound to that document's hooks. Rendered by
// the desktop detail page and by the phone's generic detail screen alike.
import { DocFilesCard } from './DocFilesCard';
import { useAuth } from '../../../auth/AuthContext';
import {
  FLOW_DOC_FILES, canWriteFlowDocFiles, fetchFlowDocFileBlobUrl,
  useDeleteFlowDocFile, useFlowDocFiles, useUploadFlowDocFile, type FlowDocKind,
} from '../lib/flow-doc-files';

export const FlowDocFilesCard = ({ kind, docId, status }: { kind: FlowDocKind; docId: string; status: string | null }) => {
  const { can, pageAccess } = useAuth();
  const filesQ = useFlowDocFiles(kind, docId);
  const upload = useUploadFlowDocFile(kind, docId);
  const remove = useDeleteFlowDocFile(kind, docId);
  const noun = FLOW_DOC_FILES[kind].noun;
  return (
    <DocFilesCard
      files={filesQ.data?.files ?? []}
      canWrite={canWriteFlowDocFiles(kind, can, pageAccess)}
      locked={filesQ.data?.locked ?? false}
      closed={String(status ?? '').trim().toUpperCase() === 'CANCELLED'}
      lockedNote={` · kept with the finished ${noun}`}
      emptyNote="No files yet. Attach the supplier's paperwork, an invoice scan or photos of the goods."
      removeBody={`The stored file is deleted. Once the ${noun} is finished its files stay.`}
      attachAriaLabel={`Attach files to this ${noun}`}
      uploading={upload.isPending} removing={remove.isPending}
      onUpload={(file) => upload.mutateAsync(file)}
      onRemove={(fileId) => remove.mutateAsync(fileId)}
      openUrl={(fileId) => fetchFlowDocFileBlobUrl(kind, docId, fileId)}
    />
  );
};

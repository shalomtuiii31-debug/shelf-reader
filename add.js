'use strict';
// Add chapters yourself: paste a novel chapter's text, or pick screenshots of a manga/manhwa chapter.
// Works for a new book or as the next chapter of one already on the shelf.

let addTarget = null;   // meta of the book being added to, or null for a new book

const addKind = () => addTarget ? (addTarget.kind === 'comic' ? 'comic' : 'novel') : $('#newKind').value;
function syncAddKind() {
  const comic = addKind() === 'comic';
  $('#pasteBox').hidden = comic;
  $('#picBox').hidden = !comic;
}
// Next chapter title: one more than the number in the last chapter's title.
function nextChapterTitle(titles) {
  const last = titles.at(-1)?.match(/\d+/);
  return `Chapter ${last ? +last[0] + 1 : titles.length + 1}`;
}

function openAdd(meta) {
  addTarget = meta || null;
  $('#addTitle').textContent = meta ? `Add to ${meta.title}` : 'New book';
  $('#bookNameRow').hidden = $('#kindRow').hidden = !!meta;
  $('#newName').value = '';
  $('#chapText').value = '';
  $('#chapPics').value = '';
  $('#picCount').textContent = '';
  $('#chapName').value = nextChapterTitle(meta?.chapterTitles || []);
  syncAddKind();
  $('#addChap').showModal();
}

// A pasted chapter often starts with its own title ("Chapter 214: ..."); use it.
function titleFromText(text) {
  const first = text.split('\n').map(clean).find(Boolean) || '';
  if (first.length < 100 && (CHAPTER_RE.test(first) || /^\d+[.:\s]/.test(first))) $('#chapName').value = first;
}

$('#newKind').onchange = syncAddKind;
$('#chapText').oninput = e => titleFromText(e.target.value);
$('#pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t.trim()) return alert('Nothing is copied yet. Copy the chapter text first.');
    $('#chapText').value = t;
    titleFromText(t);
  } catch { alert('Tap in the box below and paste there instead.'); }
};
$('#chapPics').onchange = e => {
  const n = e.target.files.length;
  $('#picCount').textContent = n ? `${n} picture${n === 1 ? '' : 's'} selected` : '';
};

$('#saveChap').onclick = async () => {
  const kind = addKind(), title = $('#chapName').value.trim() || 'Chapter';
  let paras = [], images = [];
  if (kind === 'novel') {
    paras = $('#chapText').value.replace(/\r\n?/g, '\n').split(/\n+/).map(clean).filter(Boolean);
    if (!paras.length) return alert('Paste the chapter text first.');
  } else {
    const files = [...$('#chapPics').files].sort((a, b) => natural(a.name, b.name));
    if (!files.length) return alert('Choose the screenshots for this chapter first.');
    $('#saveChap').textContent = 'Saving…';
    for (const f of files) images.push({ blob: f, ...(await dims(f)) });
  }
  try {
    if (addTarget) {
      const data = await get('books', addTarget.id);
      const base = (data.images || []).length;
      data.chapters.push({ title, paras: kind === 'comic' ? images.map((_, i) => ({ img: base + i })) : paras });
      data.images = [...(data.images || []), ...images];
      await put('books', data);
      addTarget.chapterTitles.push(title);
      if (!addTarget.cover && images[0]) addTarget.cover = images[0].blob;
      await put('meta', addTarget);
      // Already reading this book: show the new chapter straight away.
      if (book?.id === addTarget.id) {
        Object.assign(book, { meta: addTarget, chapters: data.chapters, images: data.images });
        showChapter(data.chapters.length - 1);
      }
    } else {
      const name = $('#newName').value.trim();
      if (!name) return alert('Give the book a name first.');
      await saveBook({ title: name, author: '', kind, cover: images[0]?.blob, images,
        chapters: [{ title, paras: kind === 'comic' ? images.map((_, i) => ({ img: i })) : paras }] });
    }
    $('#addChap').close();
    renderLibrary();
  } catch (e) {
    alert(`Couldn't save the chapter: ${e.message}`);
  } finally {
    $('#saveChap').textContent = 'Save chapter';
  }
};

$('#newBookBtn').onclick = () => openAdd(null);
$('#addChapBtn').onclick = () => { $('#toc').close(); openAdd(book.meta); };

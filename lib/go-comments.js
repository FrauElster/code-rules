// hand-rolled Go lexer, just enough to find comments without misreading `//`/`/*` sequences that occur
// inside string/rune/raw-string literals. Mirrors commands/comments.js's TS scanner logic: adjacent `//`
// lines with no code between them merge into one logical block; `/* */` is always one block.
export function goCommentBlocks(text) {
    const n = text.length;
    let i = 0;
    let line = 1;
    const blocks = [];
    let currentLineBlock = null;
    let currentLineBlockEndLine = -1;
    let codeSincePrevComment = true;

    while (i < n) {
        const c = text[i];
        if (c === '\n') {
            line++;
            i++;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\r') {
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            const startLine = line;
            i += 2;
            while (i < n && text[i] !== '\n') i++;
            if (currentLineBlock && !codeSincePrevComment && startLine === currentLineBlockEndLine + 1) currentLineBlock.endLine = startLine;
            else {
                currentLineBlock = { startLine, endLine: startLine };
                blocks.push(currentLineBlock);
            }
            currentLineBlockEndLine = startLine;
            codeSincePrevComment = false;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const startLine = line;
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') line++;
                i++;
            }
            i += 2;
            blocks.push({ startLine, endLine: line });
            currentLineBlock = null;
            codeSincePrevComment = false;
            continue;
        }
        if (c === '"' || c === "'") {
            const quote = c;
            i++;
            while (i < n && text[i] !== quote) {
                if (text[i] === '\\') i++;
                else if (text[i] === '\n') line++;
                i++;
            }
            i++;
            currentLineBlock = null;
            codeSincePrevComment = true;
            continue;
        }
        if (c === '`') {
            i++;
            while (i < n && text[i] !== '`') {
                if (text[i] === '\n') line++;
                i++;
            }
            i++;
            currentLineBlock = null;
            codeSincePrevComment = true;
            continue;
        }
        currentLineBlock = null;
        codeSincePrevComment = true;
        i++;
    }
    return blocks;
}

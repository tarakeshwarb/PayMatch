/**
 * Hungarian Algorithm (Kuhn-Munkres) — minimum-cost bipartite assignment.
 *
 * Finds the globally optimal one-to-one matching between rows and columns
 * of a cost matrix, minimising total cost. Equivalently, maximises total
 * score when cost[i][j] = 1 - score[i][j].
 *
 * Implementation: classical O(n³) reduction-based approach.
 *   Step 1: Subtract row minimums
 *   Step 2: Subtract column minimums
 *   Step 3: Cover all zeros with minimum number of lines
 *   Step 4: If lines == n, done. Else adjust matrix and repeat.
 * No external dependencies.
 *
 * @param costMatrix - rows × cols matrix of non-negative costs.
 *                     Rectangular input is padded to square internally.
 * @returns assignment (0-indexed): result[i] = j means row i → col j.
 *          result[i] = -1 if row i maps to a dummy padding column.
 */
export function hungarian(costMatrix: number[][]): number[] {
    const origRows = costMatrix.length;
    if (origRows === 0) return [];
    const origCols = costMatrix[0].length;
    if (origCols === 0) return new Array(origRows).fill(-1);

    const n = Math.max(origRows, origCols);
    const INF = 1e15;

    // Build n×n working matrix (pad with INF)
    const C: number[][] = [];
    for (let i = 0; i < n; i++) {
        const row: number[] = [];
        for (let j = 0; j < n; j++) {
            row.push(i < origRows && j < origCols ? costMatrix[i][j] : INF);
        }
        C.push(row);
    }

    // Step 1: subtract row minimums
    for (let i = 0; i < n; i++) {
        const min = Math.min(...C[i]);
        if (min > 0 && min < INF) {
            for (let j = 0; j < n; j++) C[i][j] = C[i][j] >= INF ? INF : C[i][j] - min;
        }
    }

    // Step 2: subtract column minimums
    for (let j = 0; j < n; j++) {
        let min = INF;
        for (let i = 0; i < n; i++) if (C[i][j] < min) min = C[i][j];
        if (min > 0 && min < INF) {
            for (let i = 0; i < n; i++) C[i][j] = C[i][j] >= INF ? INF : C[i][j] - min;
        }
    }

    // Iterative assignment via augmenting paths (Hopcroft-Karp style on zeros)
    const rowAssign = new Array(n).fill(-1); // rowAssign[i] = j
    const colAssign = new Array(n).fill(-1); // colAssign[j] = i

    // Try to greedily assign zeros first
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (C[i][j] === 0 && colAssign[j] === -1 && rowAssign[i] === -1) {
                rowAssign[i] = j;
                colAssign[j] = i;
            }
        }
    }

    // Main loop: augment until all rows are assigned
    for (let i = 0; i < n; i++) {
        if (rowAssign[i] !== -1) continue;

        // Try to find augmenting path from row i using DFS
        let found = false;
        while (!found) {
            const visited = new Array(n).fill(false);
            found = augment(i, C, rowAssign, colAssign, visited, n);

            if (!found) {
                // No augmenting path — need to adjust cost matrix
                // Find minimum uncovered value
                const coveredRow = new Array(n).fill(false);
                const coveredCol = new Array(n).fill(false);

                // Mark rows with no assignment, cols with assignment in those rows
                const markedRows = new Array(n).fill(false);
                const markedCols = new Array(n).fill(false);

                // Rows with no assignment are marked
                for (let r = 0; r < n; r++) if (rowAssign[r] === -1) markedRows[r] = true;

                // Propagate: if row r is marked and C[r][c]=0, mark col c
                //            if col c is marked and colAssign[c]=r', mark row r'
                let changed = true;
                while (changed) {
                    changed = false;
                    for (let r = 0; r < n; r++) {
                        if (!markedRows[r]) continue;
                        for (let c = 0; c < n; c++) {
                            if (!markedCols[c] && C[r][c] === 0) {
                                markedCols[c] = true;
                                changed = true;
                                if (colAssign[c] !== -1 && !markedRows[colAssign[c]]) {
                                    markedRows[colAssign[c]] = true;
                                }
                            }
                        }
                    }
                }

                // Minimum lines cover: UNmarked rows + marked cols
                for (let r = 0; r < n; r++) coveredRow[r] = !markedRows[r];
                for (let c = 0; c < n; c++) coveredCol[c] = markedCols[c];

                // Find minimum uncovered value
                let minVal = INF;
                for (let r = 0; r < n; r++) {
                    if (coveredRow[r]) continue;
                    for (let c = 0; c < n; c++) {
                        if (!coveredCol[c] && C[r][c] < minVal) minVal = C[r][c];
                    }
                }
                if (minVal === INF || minVal === 0) break; // no progress possible

                // Subtract from uncovered, add to doubly-covered
                for (let r = 0; r < n; r++) {
                    for (let c = 0; c < n; c++) {
                        if (C[r][c] >= INF) continue;
                        if (!coveredRow[r] && !coveredCol[c]) C[r][c] -= minVal;
                        else if (coveredRow[r] && coveredCol[c]) C[r][c] += minVal;
                    }
                }

                // Reset greedy assignments and try again from scratch on the new zeros
                rowAssign.fill(-1);
                colAssign.fill(-1);
                for (let r = 0; r < n; r++) {
                    for (let c = 0; c < n; c++) {
                        if (C[r][c] === 0 && colAssign[c] === -1 && rowAssign[r] === -1) {
                            rowAssign[r] = c;
                            colAssign[c] = r;
                        }
                    }
                }
                // Re-check if row i is now assigned
                if (rowAssign[i] !== -1) found = true;
            }
        }
    }

    // Extract result (only return assignments for original rows/cols)
    const result = new Array(origRows).fill(-1);
    for (let i = 0; i < origRows; i++) {
        if (rowAssign[i] !== -1 && rowAssign[i] < origCols) {
            result[i] = rowAssign[i];
        }
    }
    return result;
}

/**
 * DFS augmenting path search for unweighted bipartite matching on zero-cost edges.
 */
function augment(
    i: number,
    C: number[][],
    rowAssign: number[],
    colAssign: number[],
    visited: boolean[],
    n: number,
): boolean {
    for (let j = 0; j < n; j++) {
        if (C[i][j] === 0 && !visited[j]) {
            visited[j] = true;
            const incumbent = colAssign[j];
            if (incumbent === -1 || augment(incumbent, C, rowAssign, colAssign, visited, n)) {
                rowAssign[i] = j;
                colAssign[j] = i;
                return true;
            }
        }
    }
    return false;
}

// SPDX-License-Identifier: MIT
// OPO Flow adapter — read-only Cadence script returning the OPO required-field
// subset for one Top Shot Moment held at a specific account.
//
// Inputs:  tokenID: UInt64, holder: Address
// Returns: {
//   editionID, serial, editionSize, holder,
//   media_cids: [{rank, cid, mediaType}]   // ordered; rank 0 is adapter-preferred
// }
//
// Binding notes (SPEC §3 + §8):
//   - edition_id    := setID (TopShot.NFT.data.setID)
//   - serial        := TopShot.NFT.data.serialNumber
//   - edition_size  := TopShot.getNumMomentsInEdition(setID, playID)
//   - holder        := caller-supplied; adapter trusts `borrowMoment(id)` to
//                      confirm the token is held at that account
//   - media_cid     := first IPFSFile entry in MetadataViews.Medias; the
//                      adapter returns the full ordered list so a verifier
//                      MAY dispatch on mediaType (HERO vs VIDEO vs
//                      VIDEO_SQUARE) rather than take the first blindly.
//   - metadata_cid  := NOT exposed on-chain by the current TopShot contract.
//                      Under OPO v0.2 this is permitted when the equivalent
//                      fields (edition_id, serial, edition_size, media_cid)
//                      are all chain-sourced — chain-state acts as the
//                      pinned manifest in the limit case.

import TopShot from 0x0b2a3299cc857e29
import MetadataViews from 0x1d7e57aa55817448

access(all) struct MomentFields {
    access(all) let editionID: UInt32
    access(all) let playID: UInt32
    access(all) let serial: UInt32
    access(all) let editionSize: UInt32
    access(all) let holder: String
    access(all) let mediaCIDs: [{String: String}]

    init(
        editionID: UInt32, playID: UInt32, serial: UInt32, editionSize: UInt32,
        holder: String, mediaCIDs: [{String: String}]
    ) {
        self.editionID = editionID
        self.playID = playID
        self.serial = serial
        self.editionSize = editionSize
        self.holder = holder
        self.mediaCIDs = mediaCIDs
    }
}

access(all) fun main(tokenID: UInt64, holder: Address): MomentFields {
    let cap = getAccount(holder)
        .capabilities
        .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("no MomentCollectionPublic at holder")

    let nft = cap.borrowMoment(id: tokenID)
        ?? panic("Moment not held by this account")

    let editionID = nft.data.setID
    let playID    = nft.data.playID
    let serial    = nft.data.serialNumber
    let editionSize = TopShot.getNumMomentsInEdition(setID: editionID, playID: playID) ?? 0 as UInt32

    // Walk MetadataViews.Medias and record IPFS CIDs in declaration order.
    // This is the only on-chain, issuer-independent source of the media CID
    // set for a TopShot Moment.
    var mediaCIDs: [{String: String}] = []
    if let m = nft.resolveView(Type<MetadataViews.Medias>()) {
        let medias = m as! MetadataViews.Medias
        var i = 0
        for media in medias.items {
            if let f = media.file as? MetadataViews.IPFSFile {
                mediaCIDs.append({
                    "rank": i.toString(),
                    "cid": f.cid,
                    "mediaType": media.mediaType
                })
            }
            i = i + 1
        }
    }

    return MomentFields(
        editionID: editionID,
        playID: playID,
        serial: serial,
        editionSize: editionSize,
        holder: holder.toString(),
        mediaCIDs: mediaCIDs
    )
}

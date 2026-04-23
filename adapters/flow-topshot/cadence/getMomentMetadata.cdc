// SPDX-License-Identifier: MIT
// OPO Flow adapter — read-only Cadence script returning the OPO required-field
// subset for one Top Shot Moment held at a specific account.
//
// Inputs:  tokenID: UInt64, holder: Address
// Returns: { editionID, serial, editionSize, holder, mediaCID, metadataCID }

import TopShot from 0x0b2a3299cc857e29
import MetadataViews from 0x1d7e57aa55817448

access(all) fun main(tokenID: UInt64, holder: Address): {String: AnyStruct} {
    let acct = getAccount(holder)

    let cap = acct
        .capabilities
        .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("no MomentCollectionPublic at holder")

    let nft = cap.borrowMoment(id: tokenID)
        ?? panic("Moment not held by this account")

    // Edition + serial come from the Moment's data.
    let editionID = nft.data.setID
    let playID    = nft.data.playID
    let serial    = nft.data.serialNumber

    // Edition size: TopShot exposes getNumMomentsInEdition(setID, playID).
    let editionSize = TopShot.getNumMomentsInEdition(setID: editionID, playID: playID) ?? 0 as UInt32

    // Media + metadata CIDs surface via MetadataViews.Display + the Top Shot
    // edition view. Adapters SHOULD prefer MetadataViews over private API.
    var mediaCID = ""
    var metadataCID = ""
    if let display = nft.resolveView(Type<MetadataViews.Display>()) as? MetadataViews.Display {
        // thumbnail file is an IPFSFile in the standard adapter
        if let f = display.thumbnail as? MetadataViews.IPFSFile {
            mediaCID = f.cid
        }
    }

    return {
        "editionID": editionID,
        "serial": serial,
        "editionSize": editionSize,
        "holder": holder.toString(),
        "mediaCID": mediaCID,
        "metadataCID": metadataCID
    }
}
